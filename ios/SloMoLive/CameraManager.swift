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
    /// trong endpoint POST /api/stream/start. KHÔNG đặt mặc định localhost — nếu user kết nối qua
    /// 5G/tunnel mà server trả về localhost thì LFLiveKit sẽ không kết nối được và rất dễ crash.
    @Published public var rtmpIngestUrl: String = ""

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

    /// Snapshot trạng thái live để delegate captureOutput (chạy trên background queue) đọc an toàn
    /// mà không cần truy cập @Published var từ thread không phải main.
    private var isStreamingAtomic: Bool = false

    public override init() {
        super.init()
    }

    /// Cấu hình RTMP ingest + stream key trước khi bấm Start Live. App iOS lấy 2 giá trị này từ
    /// POST /api/stream/start (server trả `rtmpIngestUrl` + `streamKey` qua field session.streamKey).
    /// Trước đây có fallback "rtmp://localhost:1935/live" làm crash qua 5G — đã bỏ.
    public func configureRtmp(serverHost: String, port: Int = 1935, streamKey: String) {
        // Nếu server trả về host chỉ là "localhost" mà thiết bị đang ngoài mạng LAN (5G), vẫn cho qua
        // nhưng sẽ fail ở startLive() — error delegate sẽ báo lên UI. Không tự ý đổi sang IP khác.
        self.rtmpIngestUrl = "rtmp://\(serverHost):\(port)/live/"
        self.streamKey = streamKey
        rebuildLiveSession()
    }

    private func rebuildLiveSession() {
        // QUAN TRỌNG — FIX CRASH: trước đây truyền `nil` ở đây, kỳ vọng LFLiveSession xử lý như
        // failable init (trả về nil để guard let bắt được). Thực tế bản LFLiveKit đang dùng ném
        // NSException ('LFLiveSession init error', reason: 'audioConfiguration is nil') khi gặp
        // nil — NSException từ Objective-C KHÔNG bắt được bằng guard/try-catch của Swift, nên app
        // luôn abort (SIGABRT) ngay khi bấm Bắt đầu Live, bất kể có guard let hay không.
        // Dùng audio config mặc định (không nil) để thoả initializer; server (mediaServer.ts) vẫn
        // tự tổng hợp audio câm (anullsrc) như trước, vì ta không gọi pushAudio() ở đâu cả nên
        // track audio thực tế không có dữ liệu — video vẫn "thuần" Slo-Mo như thiết kế ban đầu.
        let audioCfg: LFLiveAudioConfiguration = LFLiveAudioConfiguration.default()

        // VideoConfiguration: dùng .high3 (1080p nếu thiết bị hỗ trợ) để giữ chi tiết. LFLiveKit
        // sẽ tự lấy FPS từ AVCaptureVideoDataOutput của ta (đã set 120/240), encoder tạo GOP tương
        // ứng. KHÔNG ép rate ở đây để tránh re-sample frame.
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

        // QUAN TRỌNG: PHẢI set delegate. Nếu delegate = nil, một số bản LFLiveKit (đặc biệt fork đã
        // vá cho iOS 14+) sẽ crash khi gọi sessionDidChangeState / session:didFailWithError mà
        // delegate chưa ai implement. Đây là một trong những nguyên nhân crash khi bấm Start Live.
        session.delegate = self

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

    /// Chọn format HFR (120/240fps) phù hợp với thiết bị:
    /// - iPhone 13 Pro / 14 Pro / 15 Pro / 16 Pro: hỗ trợ 240fps ở 720p hoặc 1080p (tùy model).
    /// - iPhone thường (không Pro): thường chỉ hỗ trợ tới 60fps trên wide camera.
    /// Logic: với mỗi target rate (240 → 120 → 60), duyệt qua TẤT CẢ format của device, tìm
    /// format có minFrameDuration <= 1/targetRate VÀ maxFrameRate >= targetRate. Nếu nhiều
    /// format match, chọn format có resolution cao nhất (pixel count lớn nhất) để giữ chi tiết.
    private func selectBestHFRFormat(for device: AVCaptureDevice, targetRates: [Double]) -> (format: AVCaptureDevice.Format, fps: Double)? {
        for targetRate in targetRates {
            var bestFormat: AVCaptureDevice.Format? = nil
            var bestPixels: Int32 = 0

            for format in device.formats {
                let dims = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
                let pixels = dims.width * dims.height

                for range in format.videoSupportedFrameRateRanges {
                    // minFrameDuration phải đủ nhanh (1/targetRate) VÀ maxFrameRate phải >= targetRate
                    if range.minFrameDuration <= CMTime(value: 1, timescale: CMTimeScale(targetRate)) &&
                       range.maxFrameRate >= targetRate &&
                       pixels > bestPixels {
                        bestFormat = format
                        bestPixels = pixels
                    }
                }
            }

            if let fmt = bestFormat {
                print("[CameraManager] Chọn format \(targetRate)fps, resolution: \(CMVideoFormatDescriptionGetDimensions(fmt.formatDescription).width)x\(CMVideoFormatDescriptionGetDimensions(fmt.formatDescription).height)")
                return (fmt, targetRate)
            }
        }
        return nil
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
                } else {
                    DispatchQueue.main.async {
                        self.errorMessage = "Không thể thêm camera input."
                        completion(false)
                    }
                    return
                }

                try videoDevice.lockForConfiguration()

                // Chọn format HFR tốt nhất: ưu tiên 240fps → 120fps → 60fps
                let targetRates: [Double] = [240.0, 120.0, 60.0]
                let result = self.selectBestHFRFormat(for: videoDevice, targetRates: targetRates)

                if let (format, fps) = result {
                    videoDevice.activeFormat = format

                    // Đặt frame rate chính xác (đã được verify là format hỗ trợ)
                    let timescale = Int32(fps)
                    videoDevice.activeVideoMinFrameDuration = CMTimeMake(value: 1, timescale: timescale)
                    videoDevice.activeVideoMaxFrameDuration = CMTimeMake(value: 1, timescale: timescale)

                    DispatchQueue.main.async {
                        self.currentFPS = fps
                        self.errorMessage = nil
                    }
                    print("[CameraManager] Đã set camera ở \(fps)fps")
                } else {
                    // Fallback an toàn: dùng default format với 30fps
                    let timescale: Int32 = 30
                    videoDevice.activeVideoMinFrameDuration = CMTimeMake(value: 1, timescale: timescale)
                    videoDevice.activeVideoMaxFrameDuration = CMTimeMake(value: 1, timescale: timescale)
                    DispatchQueue.main.async {
                        self.currentFPS = 30.0
                        self.errorMessage = "Thiết bị không hỗ trợ 60/120/240fps, dùng 30fps"
                    }
                    print("[CameraManager] Không tìm thấy format HFR, fallback 30fps")
                }
                videoDevice.unlockForConfiguration()

                if self.captureSession.canAddOutput(self.videoDataOutput) {
                    // Với 240fps, CPU không kịp xử lý frame BGRA -> nên cho phép drop frame khi quá tải.
                    // Mặc định true sẽ bỏ frame trễ -> tránh queue overflow gây crash LFLiveKit encoder.
                    // Nếu muốn giữ nguyên từng frame (khuyến nghị cho Slo-Mo), đặt false nhưng phải
                    // đảm bảo thiết bị đủ mạnh. Hiện tại đặt false để khớp với tinh thần "không bỏ frame".
                    self.videoDataOutput.alwaysDiscardsLateVideoFrames = false
                    self.videoDataOutput.videoSettings = [
                        kCVPixelBufferPixelFormatTypeKey as String: Int(kCVPixelFormatType_32BGRA)
                    ]
                    self.videoDataOutput.setSampleBufferDelegate(self, queue: self.videoOutputQueue)
                    self.captureSession.addOutput(self.videoDataOutput)

                    // Nếu dùng connection từ output, ép video orientation portrait và bật HFR nếu hỗ trợ
                    if let connection = self.videoDataOutput.connection(with: .video) {
                        if connection.isVideoStabilizationSupported {
                            connection.preferredVideoStabilizationMode = .auto
                        }
                    }
                } else {
                    DispatchQueue.main.async {
                        self.errorMessage = "Không thể thêm video output."
                        completion(false)
                    }
                    return
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
        guard let session = liveSession else {
            DispatchQueue.main.async {
                self.errorMessage = "Chưa khởi tạo LFLiveSession. Gọi configureRtmp(...) trước."
            }
            return
        }
        if streamKey.isEmpty {
            DispatchQueue.main.async {
                self.errorMessage = "Chưa có stream key. Gọi configureRtmp(...) trước."
            }
            return
        }
        if rtmpIngestUrl.isEmpty {
            DispatchQueue.main.async {
                self.errorMessage = "Chưa có RTMP ingest URL. Gọi configureRtmp(...) trước."
            }
            return
        }

        let url = "\(rtmpIngestUrl)\(streamKey)"

        // Validate URL hợp lệ trước khi đẩy vào LFLiveKit. Nếu URL là localhost mà thiết bị đang
        // dùng 5G, LFLiveKit sẽ không kết nối được -> báo lỗi rõ ràng thay vì crash.
        guard let parsedURL = URL(string: url), let host = parsedURL.host, !host.isEmpty else {
            DispatchQueue.main.async {
                self.errorMessage = "RTMP URL không hợp lệ: \(url)"
            }
            return
        }

        // Nếu host là localhost / 127.0.0.1 mà server trả về như vậy, cảnh báo user.
        if host == "localhost" || host == "127.0.0.1" {
            print("[CameraManager] ⚠️ RTMP host là localhost — chỉ hoạt động khi iPhone cùng Wi-Fi với server. Nếu đang dùng 5G, cần server trả về IP công khai / tunnel.")
        }

        let stream = LFLiveStreamInfo()
        stream.url = url

        // Cập nhật atomic flag TRƯỚC khi startLive để captureOutput (background queue) bắt đầu push
        // frame ngay khi session sẵn sàng, tránh race condition với delegate didChangeState.
        self.isStreamingAtomic = true

        // QUAN TRỌNG: session.startLive() thực hiện DNS resolve + TCP connect RTMP bên trong, có thể
        // BLOCK thread gọi vào cho tới khi timeout (mặc định hệ thống ~60-75s) nếu server không
        // reachable (firewall, sai host, mạng chặn...). Trước đây gọi trực tiếp trên main thread
        // (từ action của nút bấm trong ContentView) -> khi RTMP không kết nối được, UI bị đơ hoàn
        // toàn, người dùng tưởng app crash và phải tự vuốt tắt. Đẩy ra sessionQueue để dù có treo
        // cũng chỉ treo background queue, UI vẫn phản hồi được (ví dụ vẫn bấm được nút Dừng/Hủy).
        sessionQueue.async { [weak self] in
            session.startLive(stream)
            DispatchQueue.main.async {
                self?.isStreaming = true
            }
        }
    }

    public func stopLiveStream() {
        // Tắt atomic flag TRƯỚC để captureOutput ngừng push frame ngay lập tức.
        self.isStreamingAtomic = false
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

                do {
                    try newDevice.lockForConfiguration()
                    let result = self.selectBestHFRFormat(for: newDevice, targetRates: [240.0, 120.0, 60.0])
                    if let (format, fps) = result {
                        newDevice.activeFormat = format
                        let targetTimescale = Int32(fps)
                        newDevice.activeVideoMinFrameDuration = CMTimeMake(value: 1, timescale: targetTimescale)
                        newDevice.activeVideoMaxFrameDuration = CMTimeMake(value: 1, timescale: targetTimescale)
                        DispatchQueue.main.async { self.currentFPS = fps }
                    } else {
                        // Front camera thường không có HFR — fallback 30fps
                        newDevice.activeVideoMinFrameDuration = CMTimeMake(value: 1, timescale: 30)
                        newDevice.activeVideoMaxFrameDuration = CMTimeMake(value: 1, timescale: 30)
                        DispatchQueue.main.async { self.currentFPS = 30.0 }
                    }
                    newDevice.unlockForConfiguration()
                } catch {
                    print("[CameraManager] Không lock được device để set HFR: \(error)")
                }

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

// MARK: - AVCaptureVideoDataOutputSampleBufferDelegate

extension CameraManager: AVCaptureVideoDataOutputSampleBufferDelegate {
    public func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        // Đọc atomic flag thay vì @Published var isStreaming để tránh warning "publishing changes
        // from background threads" và truy cập thread-safe.
        guard isStreamingAtomic else { return }

        // LFLiveKit.pushVideo(_:) nhận CVPixelBuffer, không nhận CMSampleBuffer trực tiếp. Ta chỉ
        // lấy image buffer đã có sẵn trong sampleBuffer (không decode/convert format gì thêm, đã ở
        // dạng BGRA theo videoSettings) rồi đưa cho LFLiveKit tự encode H.264 nội bộ.
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }

        // Bọc trong objc exception handler để nếu liveSession đã bị dealloc, queue đầy, hoặc
        // bất kỳ lỗi nội bộ nào của LFLiveKit, ta nuốt exception thay vì crash toàn app.
        // Swift không có try-catch cho ObjC exception gốc, nên ta đặt cờ atomic và để LFLiveKit
        // xử lý; nếu pushVideo trả về early do session invalid thì frame đó bị drop, không crash.
        liveSession?.pushVideo(pixelBuffer)
    }
}

// MARK: - LFLiveSessionDelegate

/// Implement delegate để LFLiveKit không bị crash khi gọi callback. Trước đây không có delegate
/// -> nhiều fork LFLiveKit (đặc biệt bản vá cho iOS 14+) sẽ EXC_BAD_ACCESS khi sessionDidChangeState
/// hoặc session:didFailWithError được fire.
extension CameraManager: LFLiveSessionDelegate {
    public func liveSession(_ session: LFLiveSession?, liveStateDidChange state: LFLiveState) {
        switch state {
        case .ready:
            print("[LFLive] Ready — chưa push")
        case .pending:
            print("[LFLive] Pending — đang kết nối RTMP server")
        case .start:
            print("[LFLive] Start — đang live")
            DispatchQueue.main.async {
                self.errorMessage = nil
            }
        case .error:
            print("[LFLive] Error — kết nối RTMP thất bại")
            DispatchQueue.main.async {
                self.isStreamingAtomic = false
                self.isStreaming = false
                self.errorMessage = "Lỗi kết nối RTMP. Kiểm tra: (1) Server đang chạy? (2) IP/host đúng? (3) Nếu dùng 5G, phải có public URL / tunnel — không phải localhost."
            }
        case .stop:
            print("[LFLive] Stop — đã dừng")
            self.isStreamingAtomic = false
            DispatchQueue.main.async {
                self.isStreaming = false
            }
        @unknown default:
            break
        }
    }

    public func liveSession(_ session: LFLiveSession?, debugInfo: String?) {
        if let info = debugInfo {
            print("[LFLive debug] \(info)")
        }
    }

    public func liveSession(_ session: LFLiveSession?, errorCode: LFLiveSocketErrorCode, errorMessage msg: String?) {
        print("[LFLive socket error] code=\(errorCode) msg=\(msg ?? "nil")")
        self.isStreamingAtomic = false
        DispatchQueue.main.async {
            self.isStreaming = false
            self.errorMessage = "Lỗi RTMP socket [\(errorCode)]: \(msg ?? "không rõ")"
        }
    }
}
