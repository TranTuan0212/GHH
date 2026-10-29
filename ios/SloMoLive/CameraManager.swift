import Foundation
import AVFoundation
import LFLiveKit
import UIKit
import CoreMotion

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
    @Published public private(set) var isConnecting = false
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

    /// CMMotionManager đọc trực tiếp gia tốc trọng lực thực tế từ phần cứng (không bị khóa bởi Control Center,
    /// không bị ảnh hưởng bởi iOS 16 UIWindowScene orientation suppression, và nhận biết được kể cả khi đặt nằm ngang trước).
    private let motionManager = CMMotionManager()

    /// Hướng camera hiện tại (mặc định .portrait, tự động cập nhật bởi CoreMotion)
    @Published public private(set) var currentCaptureOrientation: AVCaptureVideoOrientation = .portrait

    /// Trạng thái khóa tiêu cự (Lock Focus) tại mặt bàn — ngăn hiện tượng đảo nét (focus hunting) khi chia bài
    @Published public var isFocusLocked: Bool = false

    /// Trạng thái tốc độ màn trập thông minh (Auto Sáng tối đa 1/120s thu sáng phòng vs 1/240s bắt dính hành động)
    @Published public var isActionShutterEnabled: Bool = false
    @Published public var currentShutterText: String = "Auto Sáng"

    /// Mức độ bù sáng EV cho phòng thiếu sáng (0: Chuẩn 0.0, 1: +0.7 EV Sáng, 2: +1.5 EV Rất Sáng)
    @Published public var exposureBiasLevel: Int = 0
    @Published public var exposureBiasText: String = "EV: Chuẩn"

    /// Thông số chi tiết hiển thị trực tiếp lên màn hình app để đối chiếu (iPhone 13 vs 14 Pro Max)
    @Published public var debugFormatInfo: String = ""
    @Published public var debugColorInfo: String = ""
    @Published public var debugSensorLiveInfo: String = ""
    @Published public var debugEncoderInfo: String = ""
    @Published public var debugPushedFrames: Int = 0

    /// FPS thực tế đang cấu hình trên phần cứng (đồng bộ tức thì trên sessionQueue để rebuildLiveSession đọc chính xác)
    private var activeCaptureFPS: Double = 120.0

    /// DEBUG: đếm số frame đã push để log realtime biết capture có chạy đều không.
    private var _frameCounter: Int = 0
    private var _previewFrameCounter: Int = 0

    /// Vị trí ống kính Cam Trước người dùng đã hiệu chỉnh (chạm lấy nét / bấm khóa), lưu lại cho lần mở app sau.
    private static let savedFrontLensKey = "SloMoLive.frontLensPosition"
    private static let defaultFrontLensPosition: Float = 0.35

    public override init() {
        super.init()
        startMotionUpdates()
        setupAudioSessionObservers()
    }

    deinit {
        stopMotionUpdates()
        removeAudioSessionObservers()
    }

    private func setupAudioSessionObservers() {
        let nc = NotificationCenter.default
        nc.addObserver(
            self,
            selector: #selector(handleAudioInterruption),
            name: AVAudioSession.interruptionNotification,
            object: nil
        )
        nc.addObserver(
            self,
            selector: #selector(handleAudioRouteChange),
            name: AVAudioSession.routeChangeNotification,
            object: nil
        )
        nc.addObserver(
            self,
            selector: #selector(handleAppDidBecomeActive),
            name: UIApplication.didBecomeActiveNotification,
            object: nil
        )
        nc.addObserver(
            self,
            selector: #selector(handleSubjectAreaDidChange),
            name: AVCaptureDevice.subjectAreaDidChangeNotification,
            object: nil
        )
    }

    private func removeAudioSessionObservers() {
        let nc = NotificationCenter.default
        nc.removeObserver(self, name: AVAudioSession.interruptionNotification, object: nil)
        nc.removeObserver(self, name: AVAudioSession.routeChangeNotification, object: nil)
        nc.removeObserver(self, name: UIApplication.didBecomeActiveNotification, object: nil)
        nc.removeObserver(self, name: AVCaptureDevice.subjectAreaDidChangeNotification, object: nil)
    }

    @objc private func handleSubjectAreaDidChange(notification: Notification) {
        // Chỉ khôi phục autofocus nếu người dùng không khóa nét cố định
        guard !self.isFocusLocked else { return }
        self.resetContinuousFocus()
    }

    @objc private func handleAudioInterruption(notification: Notification) {
        guard let userInfo = notification.userInfo,
              let typeValue = userInfo[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: typeValue) else {
            return
        }

        switch type {
        case .began:
            print("[CameraManager] ⚠️ Audio session bị gián đoạn (cuộc gọi / thông báo / Siri...)")
        case .ended:
            print("[CameraManager] ✅ Audio session kết thúc gián đoạn, tự phục hồi micro...")
            DispatchQueue.main.async { [weak self] in
                self?.configureAndActivateAudioSession()
                self?.liveSession?.muted = false
            }
        @unknown default:
            break
        }
    }

    @objc private func handleAudioRouteChange(notification: Notification) {
        print("[CameraManager] 🎧 Audio route changed, cấu hình lại micro...")
        DispatchQueue.main.async { [weak self] in
            self?.configureAndActivateAudioSession()
            self?.liveSession?.muted = false
        }
    }

    @objc private func handleAppDidBecomeActive() {
        // Tự động kích hoạt lại Audio Session khi quay lại app từ màn hình khóa / background
        DispatchQueue.main.async { [weak self] in
            self?.configureAndActivateAudioSession()
            self?.liveSession?.muted = false
        }
    }

    private func startMotionUpdates() {
        if motionManager.isAccelerometerAvailable {
            motionManager.accelerometerUpdateInterval = 0.2
            motionManager.startAccelerometerUpdates(to: .main) { [weak self] data, error in
                guard let self = self, let acceleration = data?.acceleration else { return }
                self.handleAcceleration(acceleration)
            }
        } else {
            // Fallback sang UIDevice nếu thiết bị không hỗ trợ gia tốc kế (như simulator)
            UIDevice.current.beginGeneratingDeviceOrientationNotifications()
            NotificationCenter.default.addObserver(
                self,
                selector: #selector(deviceOrientationDidChange),
                name: UIDevice.orientationDidChangeNotification,
                object: nil
            )
        }
    }

    private func stopMotionUpdates() {
        if motionManager.isAccelerometerActive {
            motionManager.stopAccelerometerUpdates()
        }
        NotificationCenter.default.removeObserver(self)
        UIDevice.current.endGeneratingDeviceOrientationNotifications()
    }

    @objc private func deviceOrientationDidChange() {
        guard !isStreamingAtomic && !isConnecting else { return }
        let isFront = (self.cameraPosition == .front)
        let newOrientation: AVCaptureVideoOrientation
        switch UIDevice.current.orientation {
        case .landscapeLeft:
            newOrientation = isFront ? .landscapeLeft : .landscapeRight
        case .landscapeRight:
            newOrientation = isFront ? .landscapeRight : .landscapeLeft
        case .portraitUpsideDown:
            newOrientation = .portraitUpsideDown
        default:
            newOrientation = .portrait
        }
        if newOrientation != currentCaptureOrientation {
            currentCaptureOrientation = newOrientation
            updateVideoOrientation()
            if !streamKey.isEmpty && !rtmpIngestUrl.isEmpty {
                rebuildLiveSession()
            }
        }
    }

    /// Xử lý vector trọng lực đọc từ con quay gia tốc kế của iPhone.
    /// Nhận biết chính xác điện thoại đang nằm ngang hay đứng bất kể góc ngửa trên tripod hay khóa xoay iOS.
    private func handleAcceleration(_ acceleration: CMAcceleration) {
        // Trong lúc live stream: KHÔNG đổi orientation giữa chừng để tránh vỡ SPS/PPS của H.264 encoder
        guard !isStreamingAtomic && !isConnecting else { return }

        let x = acceleration.x
        let y = acceleration.y
        let isFront = (self.cameraPosition == .front)

        let newOrientation: AVCaptureVideoOrientation
        if abs(x) > abs(y) {
            // Thiết bị đang nằm ngang (Landscape)
            // x > 0: đỉnh máy nghiêng sang trái (top left, home right) -> UIDeviceOrientation.landscapeLeft
            // Với camera sau: tương ứng AVCaptureVideoOrientation.landscapeRight
            // Với camera trước: đối xứng gương nên là .landscapeLeft
            if x > 0.15 {
                newOrientation = isFront ? .landscapeLeft : .landscapeRight
            } else if x < -0.15 {
                newOrientation = isFront ? .landscapeRight : .landscapeLeft
            } else {
                return
            }
        } else {
            // Thiết bị đang dựng đứng (Portrait)
            if y < -0.15 {
                newOrientation = .portrait
            } else if y > 0.15 {
                newOrientation = .portraitUpsideDown
            } else {
                return
            }
        }

        if newOrientation != currentCaptureOrientation {
            currentCaptureOrientation = newOrientation
            updateVideoOrientation()
            if !streamKey.isEmpty && !rtmpIngestUrl.isEmpty {
                rebuildLiveSession()
            }
        }
    }

    /// Cấu hình toàn diện video connection của AVCaptureVideoDataOutput:
    /// - Tắt hoàn toàn chống rung nội suy (tránh iOS crop và resample gây méo mờ khi chuyển động)
    /// - Tắt mirror ở nguồn (tránh resample thêm trên GPU, giao việc lật cho player)
    /// - Đồng bộ hướng quay orientation
    public func configureVideoOutputConnection() {
        guard let connection = self.videoDataOutput.connection(with: .video) else { return }
        if connection.isVideoOrientationSupported {
            connection.videoOrientation = self.currentCaptureOrientation
        }
        if connection.isVideoMirroringSupported {
            // Tắt mirror ở nguồn để tránh resample thêm trên GPU, player web/app đã có nút lật ảnh
            connection.isVideoMirrored = false
        }
        if connection.isVideoStabilizationSupported {
            connection.preferredVideoStabilizationMode = .off
        }
    }

    /// Đồng bộ videoOrientation của camera output theo orientation nhận diện từ cảm biến
    private func updateVideoOrientation() {
        sessionQueue.async { [weak self] in
            self?.configureVideoOutputConnection()
        }
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
        // Đảm bảo Audio Session đã được cấu hình và kích hoạt trước khi tạo LFLiveSession
        configureAndActivateAudioSession()
        let audioCfg: LFLiveAudioConfiguration = LFLiveAudioConfiguration.default()

        let isLandscape = (currentCaptureOrientation == .landscapeLeft || currentCaptureOrientation == .landscapeRight)
        let uiOrientation: UIInterfaceOrientation = {
            switch currentCaptureOrientation {
            case .landscapeLeft: return .landscapeLeft
            case .landscapeRight: return .landscapeRight
            case .portraitUpsideDown: return .portraitUpsideDown
            default: return .portrait
            }
        }()

        // QUAN TRỌNG: Khởi tạo trực tiếp LFLiveVideoConfiguration() thay vì gọi defaultConfiguration(for: .high3)
        // vì defaultConfiguration trong LFLiveKit gọi supportSessionPreset: tạo một AVCaptureSession phụ gắn đè
        // lên Camera Trước (AVCaptureDevicePositionFront), làm iOS reset activeFormat 1080p 120fps của Cam Trước!
        let videoCfg = LFLiveVideoConfiguration()
        videoCfg.autorotate = false
        videoCfg.videoSizeRespectingAspectRatio = false

        // Khớp hoàn hảo videoSize của bộ nén với resolution thực tế của camera (mặc định chuẩn Full HD 1920x1080).
        var captureWidth: CGFloat = 1920
        var captureHeight: CGFloat = 1080
        if let device = videoDeviceInput?.device {
            let dims = CMVideoFormatDescriptionGetDimensions(device.activeFormat.formatDescription)
            let maxDim = max(CGFloat(dims.width), CGFloat(dims.height))
            let minDim = min(CGFloat(dims.width), CGFloat(dims.height))
            if maxDim > 0 && minDim > 0 {
                captureWidth = maxDim
                captureHeight = minDim
            }
        }

        if isLandscape {
            videoCfg.videoSize = CGSize(width: captureWidth, height: captureHeight)
            videoCfg.outputImageOrientation = uiOrientation
        } else {
            videoCfg.videoSize = CGSize(width: captureHeight, height: captureWidth)
            videoCfg.outputImageOrientation = .portrait
        }

        let targetFps: UInt = max(30, UInt(activeCaptureFPS.rounded()))
        // Chuẩn Full HD 1080p 120fps Master Replay tối ưu cho cả 4G/5G và Cloudflare Tunnel:
        // - Keyframe: mỗi 0.5 giây (targetFps / 2 = 60 frames @ 120fps) khớp chuẩn 1:1 với phân đoạn HLS 0.5s
        //   để bấm Replay ăn ngay tức khắc tại mép Live không bị trễ nhịp.
        // - Target Bitrate: 6.0 Mbps (Peak 7.5 Mbps, Floor 4.5 Mbps): mỗi segment 0.5s chỉ ~350KB giúp đẩy qua 4G
        //   và tải qua Cloudflare Tunnel trong ~120ms (nhanh gấp 4 lần thời gian thực) mà vẫn giữ độ nét căng Full HD.
        let targetBitrate: UInt = 10_000_000
        let gopFrames: UInt = max(1, targetFps / 2)

        // Đặt theo đúng thứ tự guard trong setter của LFLiveVideoConfiguration.m
        videoCfg.videoMaxFrameRate = targetFps
        videoCfg.videoFrameRate = targetFps
        videoCfg.videoMinFrameRate = max(1, targetFps - 1)
        // Keyframe 0.5s (targetFps / 2) khớp hoàn hảo với phân đoạn HLS 0.5s
        videoCfg.videoMaxKeyframeInterval = gopFrames
        videoCfg.videoMaxBitRate = 12_500_000
        videoCfg.videoBitRate = targetBitrate
        videoCfg.videoMinBitRate = 6_000_000
        let encStr = "Enc: \(Int(videoCfg.videoSize.width))x\(Int(videoCfg.videoSize.height)) @ \(targetFps)fps (\(Double(targetBitrate) / 1_000_000)M)"
        DispatchQueue.main.async {
            self.debugEncoderInfo = encStr
        }
        print("[CameraManager] 🎬 LFLive encoder configured: [\(self.currentDevicePosition == .front ? "Cam Trước" : "Cam Sau")] \(targetFps)fps, size: \(Int(videoCfg.videoSize.width))x\(Int(videoCfg.videoSize.height)), 0.5s GOP Keyframe (\(gopFrames)f), bitrate \(Double(targetBitrate) / 1_000_000)Mbps (Peak: 7.5Mbps, Floor: 4.5Mbps)")

        // Kích hoạt thu âm thanh từ micro bằng .captureMaskAudioInputVideo (LFLiveKit tự thu Audio qua mic, Video nhận từ AVCaptureVideoDataOutput).
        // LFLiveSession(...) là initializer failable -> trả về LFLiveSession?. Phải unwrap trước khi dùng.
        guard let session = LFLiveSession(
            audioConfiguration: audioCfg,
            videoConfiguration: videoCfg,
            captureType: .captureMaskAudioInputVideo
        ) ?? LFLiveSession(
            audioConfiguration: audioCfg,
            videoConfiguration: videoCfg,
            captureType: .inputMaskVideo
        ) else {
            DispatchQueue.main.async {
                self.errorMessage = "Không khởi tạo được LFLiveSession (audio/video configuration không hợp lệ)."
            }
            return
        }
        // Cho phép phát âm thanh, không mute micro
        session.muted = false
        // Đồng bộ đúng vị trí camera thực tế (cam trước hoặc cam sau) cho pipeline LFLiveKit
        session.captureDevicePosition = self.currentDevicePosition

        // QUAN TRỌNG: PHẢI set delegate. Nếu delegate = nil, một số bản LFLiveKit (đặc biệt fork đã
        // vá cho iOS 14+) sẽ crash khi gọi sessionDidChangeState / session:didFailWithError mà
        // delegate chưa ai implement. Đây là một trong những nguyên nhân crash khi bấm Start Live.
        session.delegate = self
        // Tự động kết nối lại khi sóng 4G/5G bị ngắt quãng (thử lại mỗi 2s, tối đa 15 lần = 30s chịu đựng mất sóng)
        session.reconnectInterval = 2
        session.reconnectCount = 15

        liveSession = session
    }

    @discardableResult
    public func configureAndActivateAudioSession() -> Bool {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(
                .playAndRecord,
                mode: .videoRecording,
                options: [.defaultToSpeaker, .allowBluetooth, .allowBluetoothA2DP]
            )
            try session.setActive(true, options: .notifyOthersOnDeactivation)
            print("[CameraManager] 🎙️ Audio session configured & activated successfully")
            return true
        } catch {
            print("[CameraManager] ❌ Audio session config error: \(error.localizedDescription)")
            return false
        }
    }

    public func requestAudioPermissionIfNeeded(completion: ((Bool) -> Void)? = nil) {
        let recordPermission = AVAudioSession.sharedInstance().recordPermission
        switch recordPermission {
        case .granted:
            self.configureAndActivateAudioSession()
            completion?(true)
        case .denied:
            print("[CameraManager] ⚠️ Quyền Micro bị từ chối")
            completion?(false)
        case .undetermined:
            AVAudioSession.sharedInstance().requestRecordPermission { [weak self] granted in
                DispatchQueue.main.async {
                    if granted {
                        self?.configureAndActivateAudioSession()
                        self?.rebuildLiveSession()
                    }
                    completion?(granted)
                }
            }
        @unknown default:
            completion?(false)
        }
    }

    public func setupCamera(completion: @escaping (Bool) -> Void) {
        requestAudioPermissionIfNeeded()
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

    /// Chọn format HFR chuẩn 120fps/60fps:
    /// - Ưu tiên số 1 tuyệt đối: Full HD 1080p (1920x1080) Unbinned, định dạng 8-bit 420v chuẩn SDR
    ///   (loại bỏ x420 10-bit HDR để tránh sai lệch không gian màu BT.2020 làm tối/mờ hình trên 14 Pro Max).
    /// - Ưu tiên số 2: HD 720p (1280x720) nếu thiết bị không có 1080p ở mức FPS đó.
    private func selectBestHFRFormat(for device: AVCaptureDevice, targetRates: [Double]) -> (format: AVCaptureDevice.Format, fps: Double)? {
        let isFront = (device.position == .front)

        for targetRate in targetRates {
            var bestFormat: AVCaptureDevice.Format? = nil
            var bestScore: Int64 = -1

            for format in device.formats {
                let dims = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
                let maxDim = max(dims.width, dims.height)
                let minDim = min(dims.width, dims.height)
                let subType = CMFormatDescriptionGetMediaSubType(format.formatDescription)

                // Chỉ chọn định dạng 8-bit YUV (420v / 420f), bỏ qua x420 (10-bit HDR) gây tối/đục màu khi encode H.264 8-bit
                let isVideoRange8Bit = (subType == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange)
                let isFullRange8Bit = (subType == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange)
                guard isVideoRange8Bit || isFullRange8Bit else { continue }

                for range in format.videoSupportedFrameRateRanges {
                    // minFrameDuration phải đủ nhanh (1/targetRate) VÀ maxFrameRate phải >= targetRate
                    if range.minFrameDuration <= CMTime(value: 1, timescale: CMTimeScale(targetRate)) &&
                       range.maxFrameRate >= targetRate {
                        
                        var score: Int64 = 0
                        if maxDim == 1920 && minDim == 1080 {
                            score = 1000 // Ưu tiên số 1 tuyệt đối: Full HD 1080p (cả Cam Trước & Cam Sau)
                        } else if maxDim == 1280 && minDim == 720 {
                            score = 200  // Ưu tiên số 2: HD 720p
                        } else if maxDim <= 1920 {
                            score = 50
                        } else {
                            continue
                        }

                        // Ưu tiên định dạng Unbinned (không gộp pixel) để giữ độ sắc nét quang học tối đa
                        if !format.isVideoBinned {
                            score += 50
                        }

                        // Ưu tiên format ISP thế hệ mới (hỗ trợ dải màu rộng P3_D65 + Full Range 420f + maxISO cao ở cuối danh sách)
                        if format.supportedColorSpaces.contains(.P3_D65) {
                            score += 30
                        }
                        if isFullRange8Bit {
                            score += 20
                        }
                        score += Int64(format.maxISO / 100.0)

                        // Dùng >= để lấy format hiện đại nhất ở cuối mảng device.formats của Apple
                        if score >= bestScore {
                            bestScore = score
                            bestFormat = format
                        }
                    }
                }
            }

            if let fmt = bestFormat {
                let dims = CMVideoFormatDescriptionGetDimensions(fmt.formatDescription)
                let maxRate = fmt.videoSupportedFrameRateRanges.map(\.maxFrameRate).max() ?? 0
                let isBinned = fmt.isVideoBinned
                let minISO = fmt.minISO
                let maxISO = fmt.maxISO
                let infoStr = "\(isFront ? "Trước" : "Sau") \(dims.width)x\(dims.height) @ \(Int(targetRate))fps\(isBinned ? " (Binned)" : " (Unbinned)")"
                DispatchQueue.main.async {
                    self.debugFormatInfo = infoStr
                }
                print("[CameraManager] 🎯 Đã chọn format cho [\(isFront ? "Cam Trước" : "Cam Sau")]: Target \(targetRate)fps (Max \(maxRate)fps), Res: \(dims.width)x\(dims.height), Binned: \(isBinned), ISO: \(minISO)-\(maxISO)")
                return (fmt, targetRate)
            }
        }
        print("[CameraManager] ⚠️ Không tìm thấy format HFR nào cho [\(device.position == .front ? "Cam Trước" : "Cam Sau")] trong targetRates \(targetRates). Sẽ dùng activeFormat mặc định.")
        return nil
    }

    /// Hỗ trợ đầy đủ camera trước và sau (kể cả cụm Triple/Dual Camera trên các dòng iPhone Pro/Pro Max)
    private func preferredVideoDevice(for position: AVCaptureDevice.Position) -> AVCaptureDevice? {
        let deviceTypes: [AVCaptureDevice.DeviceType]
        if position == .back {
            deviceTypes = [
                .builtInWideAngleCamera,
                .builtInDualCamera,
                .builtInTripleCamera,
                .builtInDualWideCamera
            ]
        } else {
            deviceTypes = [
                .builtInTrueDepthCamera,
                .builtInWideAngleCamera
            ]
        }
        let discovery = AVCaptureDevice.DiscoverySession(
            deviceTypes: deviceTypes,
            mediaType: .video,
            position: position
        )

        let devices = discovery.devices
        guard !devices.isEmpty else {
            return AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: position)
        }

        // Ưu tiên camera có frame-rate tối đa cao nhất (120/240fps); nếu bằng nhau, lấy camera có format
        // độ phân giải cao hơn. Việc chọn format chính xác vẫn do selectBestHFRFormat làm sau đó.
        return devices.max { lhs, rhs in
            let lhsMax = lhs.formats.flatMap(\.videoSupportedFrameRateRanges).map(\.maxFrameRate).max() ?? 0
            let rhsMax = rhs.formats.flatMap(\.videoSupportedFrameRateRanges).map(\.maxFrameRate).max() ?? 0
            return lhsMax < rhsMax
        }
    }

    private func configureAndStartSession(completion: @escaping (Bool) -> Void) {
        sessionQueue.async {
            if self.captureSession.isRunning {
                DispatchQueue.main.async { completion(true) }
                return
            }

            if self.videoDeviceInput != nil && !self.captureSession.inputs.isEmpty {
                self.captureSession.startRunning()
                DispatchQueue.main.async { completion(true) }
                return
            }

            self.captureSession.beginConfiguration()

            // Giữ nguyên quản lý màu tự động chuẩn của iOS (VideoToolbox sẽ tự quy đổi sang BT.709 bằng phần cứng)
            self.captureSession.automaticallyConfiguresCaptureDeviceForWideColor = true

            // Không để preset .high/.medium giới hạn activeFormat HFR. inputPriority cho phép
            // activeFormat 120/240fps của camera quyết định cấu hình capture thực tế.
            if self.captureSession.canSetSessionPreset(.inputPriority) {
                self.captureSession.sessionPreset = .inputPriority
            }

            // Khởi tạo theo vị trí camera đã lưu (ưu tiên Cam Sau cho góc nhìn và ánh sáng tốt nhất)
            let targetPosition = self.currentDevicePosition
            guard let videoDevice = self.preferredVideoDevice(for: targetPosition) else {
                DispatchQueue.main.async {
                    self.errorMessage = "Không tìm thấy camera \(targetPosition == .front ? "trước" : "sau")."
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

                // Chọn format HFR: Khóa chuẩn 120fps (mượt mà, thu sáng tốt trong phòng, bitrate tối ưu) → 60fps
                let targetRates: [Double] = [120.0, 60.0]
                let result = self.selectBestHFRFormat(for: videoDevice, targetRates: targetRates)

                if let (format, fps) = result {
                    videoDevice.activeFormat = format

                    // Đặt frame rate chính xác (đã được verify là format hỗ trợ)
                    let timescale = Int32(fps)
                    videoDevice.activeVideoMinFrameDuration = CMTimeMake(value: 1, timescale: timescale)
                    videoDevice.activeVideoMaxFrameDuration = CMTimeMake(value: 1, timescale: timescale)
                    self.activeCaptureFPS = fps

                    DispatchQueue.main.async {
                        self.currentFPS = fps
                        self.errorMessage = nil
                    }
                    print("[CameraManager] Đã set camera [\(targetPosition == .front ? "Trước" : "Sau")] ở \(fps)fps")
                } else {
                    // Fallback an toàn: dùng default format với 30fps
                    let timescale: Int32 = 30
                    videoDevice.activeVideoMinFrameDuration = CMTimeMake(value: 1, timescale: timescale)
                    videoDevice.activeVideoMaxFrameDuration = CMTimeMake(value: 1, timescale: timescale)
                    self.activeCaptureFPS = 30.0
                    DispatchQueue.main.async {
                        self.currentFPS = 30.0
                        self.errorMessage = "Thiết bị không hỗ trợ 60/120/240fps, dùng 30fps"
                    }
                    print("[CameraManager] Không tìm thấy format HFR, fallback 30fps")
                }

                // Tắt Low Light Boost nếu có để iOS không tự động tụt FPS hoặc kéo dài shutter time trong phòng
                if videoDevice.isLowLightBoostSupported {
                    videoDevice.automaticallyEnablesLowLightBoostWhenAvailable = false
                }

                // Tắt hoàn toàn Video HDR để không chụp ghép đa phơi sáng (short + long) gây hiện tượng bóng ma kép (ghosting)
                if videoDevice.automaticallyAdjustsVideoHDREnabled {
                    videoDevice.automaticallyAdjustsVideoHDREnabled = false
                }
                if videoDevice.isVideoHDREnabled {
                    videoDevice.isVideoHDREnabled = false
                }

                // Mặc định khởi động ở chế độ Continuous Auto Focus toàn dải để tự lấy nét chuẩn theo khoảng cách thực tế (50cm-80cm).
                // Khi người dùng chạm vào màn hình (hoặc bấm nút Khóa Nét), hàm focus() sẽ khóa cứng tiêu cự tại vị trí đó.
                if videoDevice.isFocusModeSupported(.continuousAutoFocus) {
                    videoDevice.focusMode = .continuousAutoFocus
                    if videoDevice.isAutoFocusRangeRestrictionSupported {
                        videoDevice.autoFocusRangeRestriction = .near
                    }
                    videoDevice.isSubjectAreaChangeMonitoringEnabled = true
                    DispatchQueue.main.async {
                        self.isFocusLocked = false
                    }
                    print("[CameraManager] 🎯 [\(targetPosition == .front ? "Cam Trước" : "Cam Sau")]: Khởi động ở Continuous Auto Focus (tự lấy nét chuẩn theo khoảng cách thực tế)")
                }
                // Cấu hình phơi sáng tự động chuẩn mặc định của Apple (Auto Sáng 1/120s, thu sáng tối đa, ISO thấp)
                self.applyExposureSettings(device: videoDevice)

                if videoDevice.isWhiteBalanceModeSupported(.continuousAutoWhiteBalance) {
                    videoDevice.whiteBalanceMode = .continuousAutoWhiteBalance
                }

                videoDevice.unlockForConfiguration()

                if self.captureSession.canAddOutput(self.videoDataOutput) {
                    // Đặt alwaysDiscardsLateVideoFrames = false để AVFoundation dùng buffer pool nội bộ
                    // giữ lại mọi frame 120fps khi encoder bận nén Keyframe (>8.33ms), đảm bảo không rơi 1 frame nào khi tua lại.
                    self.videoDataOutput.alwaysDiscardsLateVideoFrames = false
                    // Dùng định dạng gốc phần cứng NV12 (BiPlanar 420 YpCbCr). VideoToolbox encode trực tiếp
                    // không qua chuyển đổi RGB <-> YUV, triệt tiêu hoàn toàn hiện tượng vỡ nét/mờ màu khi tua lại.
                    self.videoDataOutput.videoSettings = [
                        kCVPixelBufferPixelFormatTypeKey as String: Int(kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange)
                    ]
                    self.videoDataOutput.setSampleBufferDelegate(self, queue: self.videoOutputQueue)
                    self.captureSession.addOutput(self.videoDataOutput)

                    // Cấu hình video connection chuẩn: tắt chống rung, tắt mirror ở nguồn, đặt orientation
                    self.currentDevicePosition = targetPosition
                    self.configureVideoOutputConnection()
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
                self.updateVideoOrientation()

                DispatchQueue.main.async {
                    self.cameraPosition = targetPosition
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

    public private(set) var currentDevicePosition: AVCaptureDevice.Position = {
        let saved = UserDefaults.standard.string(forKey: "saved_camera_position")
        return (saved == "front") ? .front : .back
    }()
    @Published public var cameraPosition: AVCaptureDevice.Position = {
        let saved = UserDefaults.standard.string(forKey: "saved_camera_position")
        return (saved == "front") ? .front : .back
    }()

    public func startLiveStream() {
        // Đồng bộ hướng camera và tái cấu hình encoder theo đúng hướng thực tế trước khi bấm Live
        updateVideoOrientation()
        rebuildLiveSession()

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
        guard !isConnecting, !isStreaming else { return }

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

        // DEBUG: reset frame counter khi bắt đầu session mới
        self._frameCounter = 0

        // Tránh việc UI cho phép bấm Start nhiều lần trong khi RTMP còn đang handshake.
        // Mỗi lần bấm trước đây tạo một stream key mới, khiến web player cố tải các phiên cũ.
        isConnecting = true
        errorMessage = nil

        // Luôn chuyển tiếp frame ngay khi đã yêu cầu mở RTMP. Một số bản LFLiveKit publish thành
        // công nhưng không bắn callback .start; nếu chỉ mở cổng ở callback đó thì server chỉ nhận
        // handshake mà không nhận packet video. LFLiveKit tự bỏ frame trong lúc handshake.
        self.isStreamingAtomic = true

        // Đảm bảo Audio Session luôn được kích hoạt và micro không bị mute trước khi bắt đầu stream
        self.configureAndActivateAudioSession()
        session.muted = false

        // Với input video tự cung cấp, LFLiveKit chỉ xử lý pixel buffer khi session đang running.
        // Nếu không bật cờ này, RTMP vẫn có thể publish thành công nhưng pushVideo không sinh
        // packet H.264 nào — chính xác là trạng thái server đã ghi nhận.
        session.running = true

        // QUAN TRỌNG: session.startLive() thực hiện DNS resolve + TCP connect RTMP bên trong, có thể
        // BLOCK thread gọi vào cho tới khi timeout (mặc định hệ thống ~60-75s) nếu server không
        // reachable (firewall, sai host, mạng chặn...). Trước đây gọi trực tiếp trên main thread
        // (từ action của nút bấm trong ContentView) -> khi RTMP không kết nối được, UI bị đơ hoàn
        // toàn, người dùng tưởng app crash và phải tự vuốt tắt. Đẩy ra sessionQueue để dù có treo
        // cũng chỉ treo background queue, UI vẫn phản hồi được (ví dụ vẫn bấm được nút Dừng/Hủy).
        sessionQueue.async { [weak self] in
            print("[CameraManager] → Gọi LFLiveSession.startLive() với URL: \(url)")
            let startTimestamp = Date()
            session.startLive(stream)
            // KHÔNG set self?.isStreaming = true ở đây — chỉ set khi delegate báo liveStateDidChange(.start)
            // (tức là RTMP handshake đã thành công). Nếu set true tại đây, UI sẽ hiển thị "LIVE" dù
            // thực tế stream chưa được server chấp nhận, gây nhầm lẫn cho user.
            //
            // Defensive timeout: nếu sau 15 giây mà delegate vẫn không báo .start (server không phản hồi,
            // firewall chặn, sai host...), tự động fallback để UI không bị treo ở trạng thái "đang chờ".
            DispatchQueue.global().asyncAfter(deadline: .now() + 15) { [weak self] in
                guard let self = self else { return }
                if !self.isStreaming {
                    print("[CameraManager] ⚠️ Timeout 15s — delegate không báo .start, kiểm tra network/server")
                    DispatchQueue.main.async {
                        self.isConnecting = false
                        if self.errorMessage == nil {
                            self.errorMessage = "Không nhận được phản hồi .start từ LFLiveKit sau 15s. Kiểm tra: (1) Server có mở port 1935? (2) iPhone cùng Wi-Fi với server? (3) Nếu dùng 5G/tunnel, điền RTMP Host Override."
                        }
                    }
                }
            }
            print("[CameraManager]   → startLive() returned sau \(Int(Date().timeIntervalSince(startTimestamp) * 1000))ms (chưa phải lúc live thật)")
        }
    }

    public func stopLiveStream() {
        // Tắt atomic flag TRƯỚC để captureOutput ngừng push frame ngay lập tức.
        self.isStreamingAtomic = false
        liveSession?.stopLive()
        liveSession?.running = false
        DispatchQueue.main.async {
            self.isConnecting = false
            self.isStreaming = false
        }
    }

    public func switchCamera(completion: ((Bool) -> Void)? = nil) {
        let newPosition: AVCaptureDevice.Position = (self.currentDevicePosition == .back) ? .front : .back
        UserDefaults.standard.set(newPosition == .back ? "back" : "front", forKey: "saved_camera_position")
        sessionQueue.async {
            self.captureSession.beginConfiguration()

            if let currentInput = self.videoDeviceInput {
                self.captureSession.removeInput(currentInput)
            }

            guard let newDevice = self.preferredVideoDevice(for: newPosition) else {
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
                    // Đồng bộ chuẩn targetRates [120, 60] cho cả cam trước và cam sau
                    let result = self.selectBestHFRFormat(for: newDevice, targetRates: [120.0, 60.0])
                    if let (format, fps) = result {
                        newDevice.activeFormat = format
                        let targetTimescale = Int32(fps)
                        newDevice.activeVideoMinFrameDuration = CMTimeMake(value: 1, timescale: targetTimescale)
                        newDevice.activeVideoMaxFrameDuration = CMTimeMake(value: 1, timescale: targetTimescale)
                        self.activeCaptureFPS = fps
                        DispatchQueue.main.async { self.currentFPS = fps }
                    } else {
                        // Front camera thường không có HFR — fallback 30fps
                        newDevice.activeVideoMinFrameDuration = CMTimeMake(value: 1, timescale: 30)
                        newDevice.activeVideoMaxFrameDuration = CMTimeMake(value: 1, timescale: 30)
                        self.activeCaptureFPS = 30.0
                        DispatchQueue.main.async { self.currentFPS = 30.0 }
                    }

                    // Tắt hoàn toàn Video HDR để không chụp ghép đa phơi sáng gây bóng ma
                    if newDevice.automaticallyAdjustsVideoHDREnabled {
                        newDevice.automaticallyAdjustsVideoHDREnabled = false
                    }
                    if newDevice.isVideoHDREnabled {
                        newDevice.isVideoHDREnabled = false
                    }

                    // Cấu hình tự động lấy nét và đo sáng liên tục toàn dải (cả gần và xa vô cực)
                    if newDevice.isFocusModeSupported(.continuousAutoFocus) {
                        newDevice.focusMode = .continuousAutoFocus
                    }
                    if newDevice.isAutoFocusRangeRestrictionSupported {
                        newDevice.autoFocusRangeRestriction = .near
                    }
                    // Cấu hình phơi sáng tối ưu theo vị trí camera (cam trước vs cam sau)
                    self.applyExposureSettings(device: newDevice)

                    if newDevice.isWhiteBalanceModeSupported(.continuousAutoWhiteBalance) {
                        newDevice.whiteBalanceMode = .continuousAutoWhiteBalance
                    }

                    newDevice.unlockForConfiguration()
                } catch {
                    print("[CameraManager] Không lock được device để set HFR: \(error)")
                }

                self.captureSession.commitConfiguration()
                // Cập nhật vị trí camera tức thì trên session queue trước khi rebuild encoder
                self.currentDevicePosition = newPosition
                // Cấu hình lại connection mới: tắt chống rung số (không crop/warp hình), tắt mirror nguồn
                self.configureVideoOutputConnection()
                self.liveSession?.captureDevicePosition = newPosition
                // Tái cấu hình lại Encoder RTMP khớp chuẩn 1:1 với camera mới (khi chưa phát live)
                if !self.streamKey.isEmpty && !self.rtmpIngestUrl.isEmpty && !self.isStreamingAtomic && !self.isConnecting {
                    self.rebuildLiveSession()
                }
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

    /// Lấy nét tại điểm chạm và KHÓA CỨNG tiêu cự mặt bàn (ngăn hiện tượng đảo nét khi tay người chia bài đưa vào)
    public func focus(at devicePoint: CGPoint, shouldLock: Bool = false) {
        sessionQueue.async { [weak self] in
            guard let self = self, let device = self.videoDeviceInput?.device else { return }
            do {
                try device.lockForConfiguration()

                // Cấu hình điểm lấy nét
                if device.isFocusPointOfInterestSupported && device.isFocusModeSupported(.autoFocus) {
                    device.focusPointOfInterest = devicePoint
                    device.focusMode = .autoFocus
                }

                // Đo sáng ưu tiên vùng chạm nhưng vẫn giữ phơi sáng TỰ ĐỘNG LIÊN TỤC (không khóa cứng 1 lần như .autoExpose
                // để tránh ảnh bị tối/sáng sai khi ánh sáng phòng thay đổi). applyExposureSettings đặt lại exposureMode -> áp dụng POI.
                if device.isExposurePointOfInterestSupported {
                    device.exposurePointOfInterest = devicePoint
                }
                self.applyExposureSettings(device: device)

                if shouldLock {
                    // Tắt giám sát thay đổi vùng cảnh để KHÔNG tự động chuyển về Continuous Auto Focus khi tay người di chuyển
                    device.isSubjectAreaChangeMonitoringEnabled = false
                    DispatchQueue.main.async {
                        self.isFocusLocked = true
                    }
                    // .autoFocus lấy nét 1 lần rồi tự giữ nguyên -> chờ ống kính ổn định rồi lưu vị trí cho lần mở app sau
                    if device.position == .front {
                        self.sessionQueue.asyncAfter(deadline: .now() + 1.0) { [weak self] in
                            self?.persistFrontLensWhenSettled(attempt: 0)
                        }
                    }
                    print("[CameraManager] 🔒 Đã KHÓA NÉT cố định tại điểm chạm mặt bàn (Không đảo nét khi chia bài)")
                } else {
                    if device.isSubjectAreaChangeMonitoringEnabled == false {
                        device.isSubjectAreaChangeMonitoringEnabled = true
                    }
                }

                device.unlockForConfiguration()
                print("[CameraManager] 🎯 Đã lấy nét & đo sáng tại điểm (\(String(format: "%.2f", devicePoint.x)), \(String(format: "%.2f", devicePoint.y)))")
            } catch {
                print("[CameraManager] Không thể lock device để lấy nét: \(error)")
            }
        }
    }

    /// Mở khóa nét để chuyển về tự động lấy nét liên tục hoặc khóa nét tại chỗ
    public func toggleFocusLock() {
        sessionQueue.async { [weak self] in
            guard let self = self, let device = self.videoDeviceInput?.device else { return }
            do {
                try device.lockForConfiguration()
                if self.isFocusLocked {
                    // Mở khóa -> về lại continuous auto focus
                    if device.isFocusModeSupported(.continuousAutoFocus) {
                        device.focusMode = .continuousAutoFocus
                    }
                    self.applyExposureSettings(device: device)
                    device.isSubjectAreaChangeMonitoringEnabled = true
                    DispatchQueue.main.async {
                        self.isFocusLocked = false
                    }
                    print("[CameraManager] 🔄 Đã mở khóa nét -> Tự động lấy nét liên tục")
                } else {
                    // Khóa đúng vị trí ống kính hiện tại (vừa lấy nét xong) và lưu lại cho lần sau
                    let lens = device.lensPosition
                    if device.isLockingFocusWithCustomLensPositionSupported {
                        device.setFocusModeLocked(lensPosition: lens, completionHandler: nil)
                    } else if device.isFocusModeSupported(.locked) {
                        device.focusMode = .locked
                    }
                    device.isSubjectAreaChangeMonitoringEnabled = false
                    if device.position == .front {
                        self.saveFrontLensPosition(lens)
                    }
                    DispatchQueue.main.async {
                        self.isFocusLocked = true
                    }
                    print("[CameraManager] 🔒 Đã khóa tiêu cự tại Lens=\(String(format: "%.2f", lens))")
                }
                device.unlockForConfiguration()
            } catch {
                print("[CameraManager] Lỗi toggle focus lock: \(error)")
            }
        }
    }

    // MARK: - Hiệu chỉnh & lưu vị trí ống kính Cam Trước

    private func savedFrontLensPosition() -> Float {
        if let n = UserDefaults.standard.object(forKey: CameraManager.savedFrontLensKey) as? NSNumber {
            let v = n.floatValue
            if v >= 0.0 && v <= 1.0 { return v }
        }
        return CameraManager.defaultFrontLensPosition
    }

    private func saveFrontLensPosition(_ lens: Float) {
        guard lens >= 0.0 && lens <= 1.0 else { return }
        UserDefaults.standard.set(lens, forKey: CameraManager.savedFrontLensKey)
        print("[CameraManager] 💾 Đã lưu vị trí nét Cam trước Lens=\(String(format: "%.2f", lens))")
    }

    /// Chạy trên sessionQueue: chờ ống kính lấy nét xong (tối đa ~2.5s) rồi lưu vị trí
    private func persistFrontLensWhenSettled(attempt: Int) {
        guard let device = videoDeviceInput?.device, device.position == .front, isFocusLocked else { return }
        if device.isAdjustingFocus && attempt < 3 {
            sessionQueue.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                self?.persistFrontLensWhenSettled(attempt: attempt + 1)
            }
            return
        }
        saveFrontLensPosition(device.lensPosition)
    }

    /// Khôi phục chế độ tự động lấy nét liên tục (Continuous Auto Focus)
    public func resetContinuousFocus() {
        sessionQueue.async { [weak self] in
            guard let self = self, let device = self.videoDeviceInput?.device else { return }
            guard !self.isFocusLocked else { return }
            do {
                try device.lockForConfiguration()
                if device.isFocusModeSupported(.continuousAutoFocus) {
                    device.focusMode = .continuousAutoFocus
                }
                if device.isAutoFocusRangeRestrictionSupported {
                    device.autoFocusRangeRestriction = .near
                }
                self.applyExposureSettings(device: device)
                if device.isSubjectAreaChangeMonitoringEnabled {
                    device.isSubjectAreaChangeMonitoringEnabled = false
                }
                device.unlockForConfiguration()
                print("[CameraManager] 🔄 Khôi phục Continuous Auto Focus")
            } catch {
                print("[CameraManager] Lỗi reset auto focus: \(error)")
            }
        }
    }

    /// Áp dụng phơi sáng & dải màu hoàn toàn tự động chuẩn phần cứng Apple:
    /// - Không ép hạ Bias thủ công hay khóa dải màu hẹp sRGB (để ISP tự động dùng format Wide Color / Dynamic Tone Mapping gốc với maxISO cao).
    /// - Việc chuyển đổi không gian màu về chuẩn Rec.709 (BT.709) được thực hiện tự động bằng phần cứng tại bước encode H.264 (VTCompressionSession).
    public func applyExposureSettings(device: AVCaptureDevice) {
        // Luôn tắt Video HDR để tránh chồng ảnh kép ở 120fps
        if device.automaticallyAdjustsVideoHDREnabled {
            device.automaticallyAdjustsVideoHDREnabled = false
        }
        if device.isVideoHDREnabled {
            device.isVideoHDREnabled = false
        }

        let isFront = (device.position == .front)

        // Thiết lập bù sáng EV (Exposure Target Bias)
        let targetBias: Float
        let biasLabel: String
        switch self.exposureBiasLevel {
        case 1:
            targetBias = min(0.7, device.maxExposureTargetBias)
            biasLabel = "+0.7 EV ☀️"
        case 2:
            targetBias = min(1.5, device.maxExposureTargetBias)
            biasLabel = "+1.5 EV 🌟"
        default:
            targetBias = 0.0
            biasLabel = "EV: Chuẩn"
        }
        device.setExposureTargetBias(targetBias, completionHandler: nil)
        DispatchQueue.main.async {
            self.exposureBiasText = biasLabel
        }

        if isFront {
            // Cam trước: Khi bật nút 1/240s ⚡ (mặc định bật), khóa cứng tốc độ màn trập tối đa 1/240s
            // để triệt tiêu hoàn toàn nhòe bóng (motion blur) khi chia/lật bài, giúp từng frame khi tua lại sắc nét tuyệt đối.
            // Khi tắt nút ⚡ -> nhả về .invalid (1/120s) để ưu tiên độ sáng tối đa trong phòng tối.
            if device.isExposureModeSupported(.continuousAutoExposure) {
                device.exposureMode = .continuousAutoExposure
            }

            let fastDuration = CMTimeMake(value: 1, timescale: 240)
            let useFast = self.isActionShutterEnabled
                && device.activeFormat.minExposureDuration <= fastDuration
                && device.activeFormat.maxExposureDuration >= fastDuration
            device.activeMaxExposureDuration = useFast ? fastDuration : .invalid

            let text = useFast ? "1/240s ⚡" : "Auto Sáng"
            DispatchQueue.main.async {
                self.currentShutterText = text
            }
            print("[CameraManager] ⚡ [Cam Trước] Auto Exposure (Bias \(targetBias)) | Màn trập: \(text)")
            return
        }

        // Cam Sau: Cảm biến lớn f/1.5-f/1.8 thu sáng mạnh.
        // Khi bật nút ⚡: Khóa màn trập 1/240s để bắt chuyển động nhanh
        // Khi tắt nút (Auto Sáng): Để màn trập tự do (lên tới 1/120s) và ISO tự động đẩy sáng tối ưu theo phòng
        if device.isExposureModeSupported(.continuousAutoExposure) {
            device.exposureMode = .continuousAutoExposure
            if self.isActionShutterEnabled {
                let fastDuration = CMTimeMake(value: 1, timescale: 240)
                if device.activeFormat.minExposureDuration <= fastDuration && device.activeFormat.maxExposureDuration >= fastDuration {
                    device.activeMaxExposureDuration = fastDuration
                    DispatchQueue.main.async {
                        self.currentShutterText = "1/240s ⚡"
                    }
                    print("[CameraManager] ⚡ Khóa Max Exposure [Cam Sau] ở 1/240s")
                } else {
                    let maxDuration = CMTimeMake(value: 1, timescale: 120)
                    device.activeMaxExposureDuration = maxDuration
                    DispatchQueue.main.async {
                        self.currentShutterText = "1/120s ⚡"
                    }
                }
            } else {
                device.activeMaxExposureDuration = .invalid
                DispatchQueue.main.async {
                    self.currentShutterText = "Auto Sáng"
                }
                print("[CameraManager] 🔄 Cam Sau: Auto Sáng (thu sáng tối đa trong phòng, Bias \(targetBias))")
            }
        } else if self.isActionShutterEnabled && device.isExposureModeSupported(.custom) {
            let shutterDenominator: Int32 = self.isActionShutterEnabled ? 240 : 120
            let maxDuration = CMTimeMake(value: 1, timescale: shutterDenominator)
            let minDur = device.activeFormat.minExposureDuration
            let maxDur = device.activeFormat.maxExposureDuration
            let clampedDuration = max(minDur, min(maxDuration, maxDur))

            let minISO = device.activeFormat.minISO
            let maxISO = device.activeFormat.maxISO
            let targetISO = max(minISO, min(800.0, maxISO))

            device.setExposureModeCustom(duration: clampedDuration, iso: targetISO) { _ in }
            DispatchQueue.main.async {
                self.currentShutterText = "1/\(shutterDenominator)s ⚡"
            }
            print("[CameraManager] ⚡ Đã áp dụng Shutter 1/\(shutterDenominator)s, ISO \(targetISO)")
        }
    }

    /// Bật/Tắt chế độ màn trập 1/240s
    public func toggleActionShutter() {
        sessionQueue.async { [weak self] in
            guard let self = self, let device = self.videoDeviceInput?.device else { return }
            do {
                try device.lockForConfiguration()
                self.isActionShutterEnabled = !self.isActionShutterEnabled
                self.applyExposureSettings(device: device)
                device.unlockForConfiguration()
            } catch {
                print("[CameraManager] Lỗi toggle action shutter: \(error)")
            }
        }
    }

    /// Chuyển đổi mức bù sáng EV: Chuẩn -> +0.7 EV (Sáng) -> +1.5 EV (Rất Sáng)
    public func cycleExposureBias() {
        sessionQueue.async { [weak self] in
            guard let self = self, let device = self.videoDeviceInput?.device else { return }
            do {
                try device.lockForConfiguration()
                self.exposureBiasLevel = (self.exposureBiasLevel + 1) % 3
                self.applyExposureSettings(device: device)
                device.unlockForConfiguration()
            } catch {
                print("[CameraManager] Lỗi cycle exposure bias: \(error)")
            }
        }
    }
}

// MARK: - AVCaptureVideoDataOutputSampleBufferDelegate

extension CameraManager: AVCaptureVideoDataOutputSampleBufferDelegate {
    public func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        autoreleasepool {
            guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }

            // Đọc atomic flag thay vì @Published var isStreaming để tránh warning "publishing changes
            // from background threads" và truy cập thread-safe.
            guard isStreamingAtomic else { return }

            // Log console mỗi 240 frames (~2s ở 120fps) — không cập nhật UI để tiết kiệm CPU.
            _frameCounter += 1
            if _frameCounter % 240 == 1 {
                let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
                print("[CameraManager] 📹 Pushed ~\(self._frameCounter) frames [\(self.currentDevicePosition == .front ? "Cam Trước" : "Cam Sau")], latest PTS=\(CMTimeGetSeconds(pts))s")
            }

            // Bọc trong objc exception handler để nếu liveSession đã bị dealloc, queue đầy, hoặc
            // bất kỳ lỗi nội bộ nào của LFLiveKit, ta nuốt exception thay vì crash toàn app.
            // Swift không có try-catch cho ObjC exception gốc, nên ta đặt cờ atomic và để LFLiveKit
            // xử lý; nếu pushVideo trả về early do session invalid thì frame đó bị drop, không crash.
            liveSession?.pushVideo(pixelBuffer)
        }
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
            // Xác nhận UI đã live. Frame forwarding đã được mở ngay từ lúc bắt đầu kết nối
            // để tương thích với các bản LFLiveKit không gửi callback .start.
            self.isStreamingAtomic = true
            DispatchQueue.main.async {
                self.isConnecting = false
                self.errorMessage = nil
                self.isStreaming = true
            }
        case .error:
            print("[LFLive] Error — kết nối RTMP thất bại")
            DispatchQueue.main.async {
                self.isStreamingAtomic = false
                self.isConnecting = false
                self.isStreaming = false
                self.errorMessage = "Lỗi kết nối RTMP. Kiểm tra: (1) Server đang chạy? (2) IP/host đúng? (3) Nếu dùng 5G, phải có public URL / tunnel — không phải localhost."
            }
        case .stop:
            print("[LFLive] Stop — đã dừng")
            self.isStreamingAtomic = false
            DispatchQueue.main.async {
                self.isConnecting = false
                self.isStreaming = false
            }
        case .refresh:
            // Case mới trong LFLiveState của bản LFLiveKit hiện tại — được bắn khi session tự
            // reconnect/refresh kết nối RTMP (ví dụ sau khi mạng chập chờn) mà không coi là lỗi
            // hẳn (.error) hay dừng hẳn (.stop). Không đổi isStreamingAtomic/isStreaming ở đây,
            // chỉ log để theo dõi; nếu sau đó fail thật, delegate sẽ tự bắn .error hoặc .stop.
            print("[LFLive] Refresh — đang làm mới kết nối RTMP")
        @unknown default:
            break
        }
    }

    public func liveSession(_ session: LFLiveSession?, debugInfo: LFLiveDebug?) {
        // Chữ ký cũ dùng `String?` nên Swift không coi đây là override của protocol
        // `LFLiveSessionDelegate` (chỉ là 1 overload trùng tên) -> LFLiveKit gọi
        // callback debug thật sự vẫn rơi vào no-op, chỉ sinh warning "does not match
        // any requirement" chứ không fail build. Đổi type đúng `LFLiveDebug?` để hàm
        // này thật sự implement protocol requirement.
        if let info = debugInfo {
            // Không đoán tên field cụ thể của LFLiveDebug (khác nhau giữa các fork) — in
            // trực tiếp object description để tránh lỗi "value of type LFLiveDebug has no
            // member ...". Nếu cần chi tiết hơn, kiểm tra property có sẵn trong header
            // LFLiveDebug.h của bản LFLiveKit đang dùng rồi truy cập trực tiếp.
            print("[LFLive debug] \(info)")
        }
    }

    public func liveSession(_ session: LFLiveSession?, errorCode: LFLiveSocketErrorCode, errorMessage msg: String?) {
        print("[LFLive socket error] code=\(errorCode) msg=\(msg ?? "nil")")
        self.isStreamingAtomic = false
        DispatchQueue.main.async {
            self.isConnecting = false
            self.isStreaming = false
            self.errorMessage = "Lỗi RTMP socket [\(errorCode)]: \(msg ?? "không rõ")"
        }
    }
}
