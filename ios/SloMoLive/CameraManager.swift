import Foundation
import AVFoundation
import LFLiveKit

/// CameraManager đẩy luồng video 120fps/240fps gốc (không bỏ frame, không re-encode lại thành JPEG rời)
/// vào Server qua giao thức RTMP/H.264 tới `rtmp://<server>:1935/live/{streamKey}`.
///
/// Theo nguyên tắc "đơn vị lưu trữ là segment video đã nén":
/// - Camera quay ở 120/240fps HFR (CMTime 1/240s) -> xuất thẳng ra H.264 HW encoder trong AVPacket.
/// - Toàn bộ frame trong segment được giữ nguyên bên trong .ts; server (NMS + FFmpeg) chỉ slice,
///   KHÔNG cần giải nén frame rời để lưu trữ.
/// - Khi user tua lại / slow-mo, hls.js chỉ cần seek vào timestamp trong playlist, server trả nguyên
///   file .ts tương ứng — không cần dựng lại ảnh, không tốn CPU từ frame rời.
public class CameraManager: NSObject, ObservableObject {
    @Published public var isStreaming = false
    @Published public var currentFPS: Double = 240.0
    @Published public var errorMessage: String? = nil

    /// URL ingest RTMP. App iOS nhận `serverUrl` (LAN IP + port 1935) và `streamKey` từ backend
    /// trong endpoint POST /api/stream/start (đã trả `rtmpIngestUrl` rồi). Mặc định dùng localhost
    /// để dev.
    @Published public var rtmpIngestUrl: String = "rtmp://localhost:1935/live/"

    private var streamKey: String = ""

    private let captureSession = AVCaptureSession()
    private var videoDeviceInput: AVCaptureDeviceInput?
    private let videoDataOutput = AVCaptureVideoDataOutput()
    private let sessionQueue = DispatchQueue(label: "com.slomo.camera.sessionQueue")
    private let videoOutputQueue = DispatchQueue(label: "com.slomo.video.outputQueue", qos: .userInteractive)

    private var streamEpochOffset: TimeInterval?

    /// Public read-only accessor cho captureSession, để ContentView có thể tạo
    /// AVCaptureVideoPreviewLayer(session:) mà không cần captureSession là public var.
    public var session: AVCaptureSession {
        captureSession
    }

    // LFLiveSession đẩy RTMP ra ngoài; cấu hình ở đây để map đúng FPS nguồn -> segment chứa đủ
    // frame 120/240 bên trong (không downsample). audioConfig = nil để tắt audio track, chỉ phát video
    // Slo-Mo thuần.
    private var liveSession: LFLiveSession?

    public override init() {
        super.init()
    }

    /// Cấu hình RTMP ingest + stream key trước khi bấm Start Live. App iOS lấy 2 giá trị này từ
    /// POST /api/stream/start (server trả `rtmpIngestUrl` + `streamKey` qua field session.streamKey).
    public func configureRtmp(serverHost: String, port: Int = 1935, streamKey: String) {
        self.rtmpIngestUrl = "rtmp://\(serverHost):\(port)/live/"
        self.streamKey = streamKey
        rebuildLiveSession()
    }

    private func rebuildLiveSession() {
        // AudioConfiguration(nil) = không ghi audio; chỉ phát video Slo-Mo. Nếu sau này muốn kèm
        // mic thì đổi sang LFLiveAudioConfiguration.default().
        let audioCfg: LFLiveAudioConfiguration? = nil

        // VideoConfiguration: defaultQuality = LFLiveVideoQuality_Default (720p), ta dùng
        // .high3 (mức cao nhất trong nhóm High) để giữ chi tiết khi zoom/xem lại. Frame rate để
        // "raw capture" — LFLiveKit sẽ lấy đúng FPS từ AVCaptureVideoDataOutput của ta (đã set
        // 120/240), encoder sẽ tạo GOP tương ứng. KHÔNG ép rate ở đây để tránh re-sample frame.
        // Lưu ý: enum của LFLiveKit KHÔNG có case đơn "High" — chỉ có Low1/2/3, Medium1/2/3,
        // High1/2/3, Default. Nếu Xcode vẫn báo lỗi member, gõ ".high" rồi để autocomplete gợi ý
        // đúng case đang có trong bản LFLiveKit cài trong project (có thể khác giữa các fork).
        let videoCfg = LFLiveVideoConfiguration.defaultConfiguration(for: .high3)

        // LFLiveSession(audioConfiguration:videoConfiguration:) là initializer failable -> trả về
        // LFLiveSession?. Phải unwrap trước khi set property, nếu không compiler báo lỗi truy cập
        // member trên optional chưa unwrap.
        guard let session = LFLiveSession(audioConfiguration: audioCfg, videoConfiguration: videoCfg) else {
            DispatchQueue.main.async {
                self.errorMessage = "Không khởi tạo được LFLiveSession (audio/video configuration không hợp lệ)."
            }
            return
        }
        // Capture từ AVCaptureVideoDataOutput -> LFLiveKit ghép thành access unit H.264, đẩy ra RTMP.
        session.captureDevicePosition = AVCaptureDevice.Position.back
        liveSession = session
    }

    public func setupCamera(completion: @escaping (Bool) -> Void) {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            self.configureAndStartSession(completion: completion)
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { granted in
                if granted {
                    self.configureAndStartSession(completion: completion)
                } else {
                    DispatchQueue.main.async {
                        self.errorMessage = "Bạn chưa cấp quyền Camera. Vào Cài đặt > Quyền riêng tư > Camera để bật."
                        completion(false)
                    }
                }
            }
        case .denied, .restricted:
            DispatchQueue.main.async {
                self.errorMessage = "Ứng dụng chưa được cấp quyền Camera. Vào Cài đặt > Quyền riêng tư > Camera để bật."
                completion(false)
            }
        @unknown default:
            DispatchQueue.main.async {
                self.errorMessage = "Không xác định được trạng thái quyền Camera."
                completion(false)
            }
        }
    }

    private func configureAndStartSession(completion: @escaping (Bool) -> Void) {
        sessionQueue.async {
            self.captureSession.beginConfiguration()

            guard let videoDevice = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) else {
                DispatchQueue.main.async {
                    self.errorMessage = "Không tìm thấy camera."
                    completion(false)
                }
                return
            }

            do {
                let videoInput = try AVCaptureDeviceInput(device: videoDevice)
                if self.captureSession.canAddInput(videoInput) {
                    self.captureSession.addInput(videoInput)
                    self.videoDeviceInput = videoInput
                }

                var selectedFormat: AVCaptureDevice.Format? = nil
                for format in videoDevice.formats {
                    for range in format.videoSupportedFrameRateRanges {
                        if range.maxFrameRate >= 240.0 {
                            selectedFormat = format
                            break
                        }
                    }
                    if selectedFormat != nil { break }
                }

                try videoDevice.lockForConfiguration()
                if let format = selectedFormat {
                    videoDevice.activeFormat = format
                    videoDevice.activeVideoMinFrameDuration = CMTimeMake(value: 1, timescale: 240)
                    videoDevice.activeVideoMaxFrameDuration = CMTimeMake(value: 1, timescale: 240)
                    DispatchQueue.main.async { self.currentFPS = 240.0 }
                } else {
                    videoDevice.activeVideoMinFrameDuration = CMTimeMake(value: 1, timescale: 60)
                    videoDevice.activeVideoMaxFrameDuration = CMTimeMake(value: 1, timescale: 60)
                    DispatchQueue.main.async { self.currentFPS = 60.0 }
                }
                videoDevice.unlockForConfiguration()

                if self.captureSession.canAddOutput(self.videoDataOutput) {
                    // Bỏ alwaysDiscardsLateVideoFrames: bây giờ ta muốn GIỮ đủ frame 120/240fps để
                    // segment chứa toàn bộ frame nguồn. Nếu encoder tạm chậm, LFLiveKit sẽ tự back-pressure
                    // thay vì vứt frame âm thầm.
                    self.videoDataOutput.alwaysDiscardsLateVideoFrames = false
                    self.videoDataOutput.videoSettings = [
                        kCVPixelBufferPixelFormatTypeKey as String: Int(kCVPixelFormatType_32BGRA)
                    ]
                    self.videoDataOutput.setSampleBufferDelegate(self, queue: self.videoOutputQueue)
                    self.captureSession.addOutput(self.videoDataOutput)
                }

                self.captureSession.commitConfiguration()
                self.streamEpochOffset = nil
                self.captureSession.startRunning()

                DispatchQueue.main.async {
                    completion(true)
                }
            } catch {
                self.captureSession.commitConfiguration()
                DispatchQueue.main.async {
                    self.errorMessage = "Lỗi cấu hình Camera: \(error.localizedDescription)"
                    completion(false)
                }
            }
        }
    }

    @Published public var cameraPosition: AVCaptureDevice.Position = .back

    public func startLiveStream() {
        // Bật RTMP push — server (NMS + FFmpeg) sẽ slice thành HLS .ts/.m3u8.
        guard let session = liveSession, !streamKey.isEmpty else {
            DispatchQueue.main.async {
                self.errorMessage = "Chưa cấu hình RTMP server / stream key. Gọi configureRtmp(...) trước."
            }
            return
        }
        let url = "\(rtmpIngestUrl)\(streamKey)"
        let stream = LFLiveStreamInfo()
        stream.url = url
        session.startLive(stream)
        DispatchQueue.main.async {
            self.isStreaming = true
        }
    }

    public func stopLiveStream() {
        liveSession?.stopLive()
        DispatchQueue.main.async {
            self.isStreaming = false
        }
    }

    public func switchCamera(completion: ((Bool) -> Void)? = nil) {
        let newPosition: AVCaptureDevice.Position = (self.cameraPosition == .back) ? .front : .back
        sessionQueue.async {
            self.captureSession.beginConfiguration()

            if let currentInput = self.videoDeviceInput {
                self.captureSession.removeInput(currentInput)
            }

            guard let newDevice = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: newPosition) else {
                self.captureSession.commitConfiguration()
                DispatchQueue.main.async {
                    self.errorMessage = "Không tìm thấy camera \(newPosition == .front ? "trước" : "sau")."
                    completion?(false)
                }
                return
            }

            do {
                let newInput = try AVCaptureDeviceInput(device: newDevice)
                if self.captureSession.canAddInput(newInput) {
                    self.captureSession.addInput(newInput)
                    self.videoDeviceInput = newInput
                }

                var highestFormat: AVCaptureDevice.Format? = nil
                var maxRate: Double = 30.0
                for format in newDevice.formats {
                    for range in format.videoSupportedFrameRateRanges {
                        if range.maxFrameRate > maxRate {
                            maxRate = range.maxFrameRate
                            highestFormat = format
                        }
                    }
                }

                try newDevice.lockForConfiguration()
                if let format = highestFormat {
                    newDevice.activeFormat = format
                    let targetTimescale = Int32(min(maxRate, 240.0))
                    newDevice.activeVideoMinFrameDuration = CMTimeMake(value: 1, timescale: targetTimescale)
                    newDevice.activeVideoMaxFrameDuration = CMTimeMake(value: 1, timescale: targetTimescale)
                    DispatchQueue.main.async { self.currentFPS = Double(targetTimescale) }
                } else {
                    newDevice.activeVideoMinFrameDuration = CMTimeMake(value: 1, timescale: 60)
                    newDevice.activeVideoMaxFrameDuration = CMTimeMake(value: 1, timescale: 60)
                    DispatchQueue.main.async { self.currentFPS = 60.0 }
                }
                newDevice.unlockForConfiguration()

                self.captureSession.commitConfiguration()
                DispatchQueue.main.async {
                    self.cameraPosition = newPosition
                    completion?(true)
                }
            } catch {
                self.captureSession.commitConfiguration()
                DispatchQueue.main.async {
                    self.errorMessage = "Lỗi đổi camera: \(error.localizedDescription)"
                    completion?(false)
                }
            }
        }
    }
}

extension CameraManager: AVCaptureVideoDataOutputSampleBufferDelegate {
    public func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard isStreaming else { return }
        // LFLiveKit.pushVideo(_:) nhận CVPixelBuffer, không nhận CMSampleBuffer trực tiếp. Ta chỉ
        // lấy image buffer đã có sẵn trong sampleBuffer (không decode/convert format gì thêm, đã ở
        // dạng BGRA theo videoSettings) rồi đưa cho LFLiveKit tự encode H.264 nội bộ. KHÔNG nén
        // JPEG, KHÔNG gửi qua WebSocket. Toàn bộ frame 120/240 vẫn được giữ nguyên trong segment
        // video .ts sinh ra phía server — đây là đơn vị lưu trữ DVR duy nhất.
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        liveSession?.pushVideo(pixelBuffer)
    }
}
