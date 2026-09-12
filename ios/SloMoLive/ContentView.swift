import SwiftUI
import AVFoundation

struct CameraPreviewView: UIViewRepresentable {
    let session: AVCaptureSession

    func makeUIView(context: Context) -> UIView {
        let view = UIView(frame: CGRect.zero)
        let previewLayer = AVCaptureVideoPreviewLayer(session: session)
        previewLayer.videoGravity = .resizeAspectFill
        view.layer.addSublayer(previewLayer)
        context.coordinator.previewLayer = previewLayer
        return view
    }

    func updateUIView(_ uiView: UIView, context: Context) {
        DispatchQueue.main.async {
            context.coordinator.previewLayer?.frame = uiView.bounds
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    class Coordinator {
        var previewLayer: AVCaptureVideoPreviewLayer?
    }
}

struct ContentView: View {
    @StateObject private var cameraManager = CameraManager()
    @StateObject private var networkManager = NetworkManager.shared
    @StateObject private var locationManager = LocationManager.shared
    @StateObject private var networkMonitor = NetworkMonitor.shared

    @State private var usernameInput = "demouser"
    @State private var passwordInput = "user123"
    @State private var isFakeLocked = false
    @State private var serverInfoChecked = false
    @State private var serverInfoHint: String? = nil

    // Tự động kiểm tra server ngay khi mở app — giúp user biết IP LAN đúng và có cảnh báo sớm
    // về tình huống mạng (LAN / Cloudflare / 5G).
    private func checkServerOnAppear() {
        guard !serverInfoChecked else { return }
        serverInfoChecked = true
        networkManager.fetchServerInfo { ok, json in
            if ok, let json = json, let server = json["server"] as? [String: Any] {
                if let hint = server["recommendedServerURL"] as? String {
                    self.serverInfoHint = "Server đề xuất: \(hint)"
                }
            }
        }
    }

    // customRtmpHost / customRtmpPort giờ sống trong networkManager (đã @Published + lưu
    // UserDefaults ở đó) để NetworkManager.startStream() có thể đọc và gửi lên server qua
    // header X-RTMP-Host / X-RTMP-Port. Xem NetworkManager.swift.

    var body: some View {
        ZStack {
            Color.black.edgesIgnoringSafeArea(.all)
                .onAppear { checkServerOnAppear() }

            if !networkManager.isAuthenticated {
                // Login View
                ScrollView {
                    VStack(spacing: 24) {
                        VStack(spacing: 8) {
                            Image(systemName: "video.badge.plus")
                                .font(.system(size: 50))
                                .foregroundColor(.indigo)

                            Text("SloMo Live 240FPS")
                                .font(.title)
                                .fontWeight(.bold)
                                .foregroundColor(.white)

                            Text("iOS Streamer Client & Hardware Device Lock")
                                .font(.caption)
                                .foregroundColor(.gray)
                        }
                        .padding(.top, 20)

                        if let err = networkManager.errorMessage {
                            Text(err)
                                .font(.caption)
                                .foregroundColor(.red)
                                .multilineTextAlignment(.center)
                                .padding()
                                .background(Color.red.opacity(0.15))
                                .cornerRadius(12)
                        }

                        if let hint = serverInfoHint {
                            Text(hint)
                                .font(.caption2)
                                .foregroundColor(.green)
                                .multilineTextAlignment(.center)
                                .padding(8)
                                .background(Color.green.opacity(0.1))
                                .cornerRadius(8)
                        }

                        VStack(alignment: .leading, spacing: 16) {
                            VStack(alignment: .leading, spacing: 4) {
                                Text("Server IP / VPS Host URL:")
                                    .font(.caption)
                                    .fontWeight(.semibold)
                                    .foregroundColor(.indigo)
                                TextField("http://YOUR_VPS_IP:4000", text: $networkManager.serverURL)
                                    .textFieldStyle(RoundedBorderTextFieldStyle())
                                    .autocapitalization(.none)
                                    .disableAutocorrection(true)
                                Text("Cùng Wi-Fi: http://192.145.X.X:4000 | Cloudflare: https://xxxx.trycloudflare.com (Không thêm :4000)")
                                    .font(.system(size: 10))
                                    .foregroundColor(.yellow)
                            }

                            VStack(alignment: .leading, spacing: 4) {
                                Text("Tài khoản User:")
                                    .font(.caption)
                                    .fontWeight(.semibold)
                                    .foregroundColor(.gray)
                                TextField("Username", text: $usernameInput)
                                    .textFieldStyle(RoundedBorderTextFieldStyle())
                                    .autocapitalization(.none)
                            }

                            VStack(alignment: .leading, spacing: 4) {
                                Text("Mật khẩu:")
                                    .font(.caption)
                                    .fontWeight(.semibold)
                                    .foregroundColor(.gray)
                                SecureField("Password", text: $passwordInput)
                                    .textFieldStyle(RoundedBorderTextFieldStyle())
                            }

                            VStack(alignment: .leading, spacing: 4) {
                                Text("RTMP Host Override (chỉ dùng khi 5G/Tunnel):")
                                    .font(.caption2)
                                    .fontWeight(.semibold)
                                    .foregroundColor(.gray)
                                TextField("vd: tunnel-xyz.trycloudflare.com", text: $networkManager.customRtmpHost)
                                    .textFieldStyle(RoundedBorderTextFieldStyle())
                                    .autocapitalization(.none)
                                    .disableAutocorrection(true)
                                HStack {
                                    Text("Port: ")
                                        .font(.caption2)
                                        .foregroundColor(.gray)
                                    TextField("1935", text: $networkManager.customRtmpPort)
                                        .textFieldStyle(RoundedBorderTextFieldStyle())
                                        .keyboardType(.numberPad)
                                        .frame(maxWidth: 100)
                                }
                                Text("Để trống nếu dùng Wi-Fi LAN. Nếu server đã trả URL đúng qua Host header thì cũng để trống.")
                                    .font(.system(size: 9))
                                    .foregroundColor(.yellow)
                            }
                            .padding(8)
                            .background(Color.white.opacity(0.05))
                            .cornerRadius(8)

                            VStack(alignment: .leading, spacing: 4) {
                                Text("Hardware Device UUID (Keychain Locked):")
                                    .font(.caption2)
                                    .foregroundColor(.gray)
                                Text(DeviceBindingManager.shared.getOrCreateDeviceUUID())
                                    .font(.system(size: 10, design: .monospaced))
                                    .foregroundColor(.yellow)
                                    .lineLimit(1)
                            }
                            .padding(8)
                            .background(Color.white.opacity(0.05))
                            .cornerRadius(8)

                            Button(action: {
                                networkManager.loginMobile(username: usernameInput, password: passwordInput) { success in
                                    if success {
                                        locationManager.requestPermissions()
                                        cameraManager.setupCamera { _ in }
                                    }
                                }
                            }) {
                                Text("ĐĂNG NHẬP THIẾT BỊ LIVE")
                                    .font(.headline)
                                    .foregroundColor(.white)
                                    .frame(maxWidth: .infinity)
                                    .padding()
                                    .background(Color.indigo)
                                    .cornerRadius(16)
                            }
                        }
                        .padding()
                        .background(Color.white.opacity(0.08))
                        .cornerRadius(24)
                    }
                    .padding()
                }
            } else {
                // Live Stream Camera Preview View
                ZStack {
                    CameraPreviewView(session: cameraManager.session)
                        .edgesIgnoringSafeArea(.all)

                    // Overlay Status Bar
                    VStack {
                        HStack {
                            VStack(alignment: .leading, spacing: 4) {
                                HStack {
                                    Circle()
                                        .fill(cameraManager.isStreaming ? Color.red : Color.gray)
                                        .frame(width: 12, height: 12)
                                    Text(cameraManager.isStreaming ? "LIVE \(Int(cameraManager.currentFPS)) FPS" : "SẴN SÀNG")
                                        .font(.caption)
                                        .fontWeight(.bold)
                                        .foregroundColor(.white)
                                }

                                Text("FPS: \(Int(cameraManager.currentFPS)) | User: \(networkManager.currentUsername ?? "")")
                                    .font(.caption2)
                                    .foregroundColor(.yellow)
                            }
                            .padding(12)
                            .background(Color.black.opacity(0.7))
                            .cornerRadius(16)

                            Spacer()

                            // Flip Camera Button (Cam Trước / Cam Sau)
                            Button(action: {
                                cameraManager.switchCamera()
                            }) {
                                HStack(spacing: 4) {
                                    Image(systemName: "camera.rotate.fill")
                                        .font(.system(size: 14))
                                    Text(cameraManager.cameraPosition == .front ? "Cam Trước" : "Cam Sau")
                                        .font(.caption2)
                                        .fontWeight(.bold)
                                }
                                .foregroundColor(.white)
                                .padding(8)
                                .background(Color.indigo.opacity(0.8))
                                .cornerRadius(12)
                            }

                            // GPS Indicator
                            if let loc = locationManager.lastKnownLocation {
                                VStack(alignment: .trailing) {
                                    Text("GPS Active")
                                        .font(.caption2)
                                        .fontWeight(.bold)
                                        .foregroundColor(.green)
                                    Text("\(String(format: "%.4f", loc.latitude)), \(String(format: "%.4f", loc.longitude))")
                                        .font(.system(size: 9, design: .monospaced))
                                        .foregroundColor(.white)
                                }
                                .padding(8)
                                .background(Color.black.opacity(0.7))
                                .cornerRadius(12)
                            }
                        }
                        .padding()

                        Spacer()

                        // Banner cảnh báo loại mạng — quan trọng cho việc chọn RTMP URL
                        NetworkStatusBanner(monitor: networkMonitor, networkManager: networkManager)
                            .padding(.horizontal)
                            .padding(.bottom, 8)

                        // Controls Bar
                        VStack(spacing: 16) {
                            Button(action: {
                                if cameraManager.isStreaming || cameraManager.isConnecting {
                                    cameraManager.stopLiveStream()
                                    locationManager.stopTracking()
                                    networkManager.stopStream()
                                } else {
                                    networkManager.startStream { ok in
                                        guard ok else {
                                            DispatchQueue.main.async {
                                                networkManager.errorMessage = "Không khởi tạo được phiên live trên server."
                                            }
                                            return
                                        }
                                        // Bắt buộc phải có ingestUrl từ server. Nếu server trả về localhost
                                        // mà thiết bị đang 5G, vẫn tiếp tục nhưng sẽ fail ở LFLiveKit và báo
                                        // lỗi rõ ràng qua delegate.
                                        guard let ingestUrl = networkManager.rtmpIngestUrl,
                                              let key = networkManager.streamKey,
                                              !ingestUrl.isEmpty, !key.isEmpty else {
                                            DispatchQueue.main.async {
                                                networkManager.errorMessage = "Server không trả về RTMP ingest URL. Kiểm tra server có trả field 'rtmpIngestUrl' trong /api/stream/start."
                                            }
                                            return
                                        }
                                        // ingestUrl dạng "rtmp://<host>:1935/live" -> tách ra host + port
                                        // rồi truyền cho CameraManager để khởi tạo LFLiveSession.
                                        let stripped = ingestUrl
                                            .replacingOccurrences(of: "rtmp://", with: "")
                                            .replacingOccurrences(of: "/live", with: "")
                                        let parts = stripped.split(separator: ":")
                                        let host = String(parts[0])
                                        let port = parts.count > 1 ? Int(parts[1]) ?? 1935 : 1935
                                        cameraManager.configureRtmp(serverHost: host, port: port, streamKey: key)
                                        cameraManager.startLiveStream()
                                        locationManager.startTracking()
                                        locationManager.onGpsUpdated = { lat, lng in
                                            networkManager.sendGPS(lat: lat, lng: lng)
                                        }
                                    }
                                }
                            }) {
                                HStack {
                                    Image(systemName: (cameraManager.isStreaming || cameraManager.isConnecting) ? "stop.fill" : "play.fill")
                                    Text(cameraManager.isStreaming ? "DỪNG PHÁT LIVE" : (cameraManager.isConnecting ? "ĐANG KẾT NỐI — BẤM ĐỂ HỦY" : "BẮT ĐẦU LIVE 240FPS"))
                                        .fontWeight(.bold)
                                }
                                .font(.title3)
                                .foregroundColor(.white)
                                .padding(.horizontal, 32)
                                .padding(.vertical, 16)
                                .background((cameraManager.isStreaming || cameraManager.isConnecting) ? Color.red : Color.indigo)
                                .cornerRadius(20)
                                .shadow(radius: 10)
                            }

                            // Fake Lock / Stealth Screen Saver Button
                            Button(action: {
                                showFakeBlackScreen()
                            }) {
                                HStack(spacing: 6) {
                                    Image(systemName: "lock.fill")
                                    Text("KHÓA MÀN HÌNH ĐEN (LIVE ẨN)")
                                        .font(.caption)
                                        .fontWeight(.bold)
                                }
                                .foregroundColor(.white)
                                .padding(.horizontal, 18)
                                .padding(.vertical, 10)
                                .background(Color.black.opacity(0.8))
                                .cornerRadius(14)
                                .overlay(
                                    RoundedRectangle(cornerRadius: 14)
                                        .stroke(Color.gray.opacity(0.4), lineWidth: 1)
                                )
                            }

                            Button(action: {
                                networkManager.isAuthenticated = false
                            }) {
                                Text("Đăng xuất")
                                    .font(.caption)
                                    .foregroundColor(.gray)
                            }
                        }
                        .padding(.bottom, 40)
                    }
                }
            }
        }
        .onAppear {
            // 1. Bấm 3 lần GIẢM âm lượng -> Mở sáng màn hình
            VolumeObserver.shared.onTripleVolumeDown = {
                DispatchQueue.main.async {
                    self.hideFakeBlackScreen()
                }
            }
            // 2. Bấm 3 lần TĂNG âm lượng -> Tắt hẳn app (exit(0))
            VolumeObserver.shared.onTripleVolumeUp = {
                DispatchQueue.main.async {
                    print("[ContentView] Người dùng bấm 3 lần Tăng Âm Lượng -> Thoát app ngay lập tức!")
                    exit(0)
                }
            }
            VolumeObserver.shared.resetVolumeSliderToMid()
            enableSystemGestureDeferral()
        }
    }

    // MARK: - Black Screen Window (phủ TOÀN BỘ màn hình kể cả status bar + home indicator)
    func showFakeBlackScreen() {
        isFakeLocked = true
        BlackScreenManager.shared.show()
    }

    func hideFakeBlackScreen() {
        isFakeLocked = false
        BlackScreenManager.shared.hide()
    }
}

/// Singleton quản lý UIWindow đen phủ toàn màn hình.
/// Dùng class (reference type) để có thể giữ tham chiếu UIWindow mà không bị giải phóng.
final class BlackScreenManager {
    static let shared = BlackScreenManager()
    private var blackWindow: UIWindow?
    private var backgroundObserver: NSObjectProtocol?

    private init() {}

    func show() {
        DispatchQueue.main.async {
            guard let windowScene = UIApplication.shared.connectedScenes
                .compactMap({ $0 as? UIWindowScene })
                .first(where: { $0.activationState == .foregroundActive })
                ?? UIApplication.shared.connectedScenes.first as? UIWindowScene
            else { return }

            let win = UIWindow(windowScene: windowScene)
            win.windowLevel = UIWindow.Level(rawValue: 2000)
            win.backgroundColor = .black
            win.isUserInteractionEnabled = true

            let vc = BlackViewController()
            win.rootViewController = vc
            win.alpha = 1
            win.isHidden = false
            win.makeKeyAndVisible()
            self.blackWindow = win

            UIScreen.main.brightness = 0.0
            UIApplication.shared.isIdleTimerDisabled = true
            print("[BlackScreenManager] Màn hình đen ON")

            // Khi bấm nút khoá phần cứng (Lock/Power) → app vào background → thoát luôn
            // để tránh khi mở khoá lại bị lộ màn hình đen của app.
            self.backgroundObserver = NotificationCenter.default.addObserver(
                forName: UIApplication.didEnterBackgroundNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                guard self?.blackWindow != nil else { return }
                print("[BlackScreenManager] App vào background khi màn hình đen → exit(0)")
                exit(0)
            }
        }
    }

    func hide() {
        DispatchQueue.main.async {
            // Tháo observer trước khi ẩn để không tự exit khi hide() được gọi tường minh
            if let obs = self.backgroundObserver {
                NotificationCenter.default.removeObserver(obs)
                self.backgroundObserver = nil
            }
            self.blackWindow?.resignKey()
            self.blackWindow?.isHidden = true
            self.blackWindow = nil
            UIScreen.main.brightness = 0.6
            UIApplication.shared.isIdleTimerDisabled = false
            VolumeObserver.shared.resetVolumeSliderToMid()
            print("[BlackScreenManager] Màn hình đen OFF")
        }
    }
}

/// ViewController phủ hoàn toàn: ẩn status bar, ẩn home indicator, nhận phím cứng, hoãn cử chỉ vuốt đáy
private class BlackViewController: UIViewController {
    override var prefersStatusBarHidden: Bool { true }
    override var preferredStatusBarUpdateAnimation: UIStatusBarAnimation { .none }
    override var prefersHomeIndicatorAutoHidden: Bool { true }
    override var preferredScreenEdgesDeferringSystemGestures: UIRectEdge { [.bottom, .all] }
    override var canBecomeFirstResponder: Bool { true }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        VolumeObserver.shared.attachVolumeView(to: view)
        becomeFirstResponder()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        setNeedsUpdateOfScreenEdgesDeferringSystemGestures()
        setNeedsUpdateOfHomeIndicatorAutoHidden()
        setNeedsStatusBarAppearanceUpdate()
        becomeFirstResponder()
    }

    // Nuốt toàn bộ tương tác chạm và cử chỉ vuốt trên màn hình đen
    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {}
    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {}
    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {}
    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {}
}

/// Banner cảnh báo loại mạng hiện tại. Hiển thị rõ ràng khi iPhone đang dùng Cellular (4G/5G)
/// mà RTMP server lại là IP LAN → không kết nối được.
struct NetworkStatusBanner: View {
    @ObservedObject var monitor: NetworkMonitor
    @ObservedObject var networkManager: NetworkManager

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Image(systemName: iconName)
                    .foregroundColor(iconColor)
                Text("Mạng: \(monitor.currentInterface.rawValue)")
                    .font(.caption2)
                    .fontWeight(.bold)
                    .foregroundColor(.white)
                if monitor.isExpensive {
                    Text("(tốn data)")
                        .font(.system(size: 9))
                        .foregroundColor(.orange)
                }
            }
            Text(monitor.interfaceDescription)
                .font(.system(size: 9))
                .foregroundColor(.gray)

            if let warning = currentWarning() {
                HStack(spacing: 4) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundColor(.yellow)
                    Text(warning)
                        .font(.system(size: 9))
                        .foregroundColor(.yellow)
                        .multilineTextAlignment(.leading)
                }
                .padding(6)
                .background(Color.yellow.opacity(0.1))
                .cornerRadius(6)
            }
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.black.opacity(0.7))
        .cornerRadius(12)
    }

    private var iconName: String {
        switch monitor.currentInterface {
        case .wifi: return "wifi"
        case .cellular: return "antenna.radiowaves.left.and.right"
        case .wired: return "cable.connector"
        case .offline: return "wifi.slash"
        case .unknown: return "questionmark.circle"
        }
    }

    private var iconColor: Color {
        switch monitor.currentInterface {
        case .wifi: return .green
        case .cellular: return .orange
        case .wired: return .blue
        case .offline: return .red
        case .unknown: return .gray
        }
    }

    private func currentWarning() -> String? {
        if let ingestUrl = networkManager.rtmpIngestUrl {
            return monitor.shouldWarnAboutRTMP(ingestUrl)
        }
        return nil
    }
}

struct ContentView_Previews: PreviewProvider {
    static var previews: some View {
        ContentView()
    }
}

// MARK: - Chống vuốt đáy thoát app (Defer system gestures on bottom & all edges)
private var didSwizzleSystemGestures = false

func enableSystemGestureDeferral() {
    guard !didSwizzleSystemGestures else { return }
    didSwizzleSystemGestures = true

    let originalSelector = #selector(getter: UIViewController.preferredScreenEdgesDeferringSystemGestures)
    let swizzledSelector = #selector(UIViewController.swizzled_preferredScreenEdgesDeferringSystemGestures)

    if let originalMethod = class_getInstanceMethod(UIViewController.self, originalSelector),
       let swizzledMethod = class_getInstanceMethod(UIViewController.self, swizzledSelector) {
        method_exchangeImplementations(originalMethod, swizzledMethod)
    }

    let originalHomeSelector = #selector(getter: UIViewController.prefersHomeIndicatorAutoHidden)
    let swizzledHomeSelector = #selector(UIViewController.swizzled_prefersHomeIndicatorAutoHidden)

    if let originalHomeMethod = class_getInstanceMethod(UIViewController.self, originalHomeSelector),
       let swizzledHomeMethod = class_getInstanceMethod(UIViewController.self, swizzledHomeSelector) {
        method_exchangeImplementations(originalHomeMethod, swizzledHomeMethod)
    }

    DispatchQueue.main.async {
        for scene in UIApplication.shared.connectedScenes {
            if let windowScene = scene as? UIWindowScene {
                for window in windowScene.windows {
                    window.rootViewController?.setNeedsUpdateOfScreenEdgesDeferringSystemGestures()
                    window.rootViewController?.setNeedsUpdateOfHomeIndicatorAutoHidden()
                    window.rootViewController?.setNeedsStatusBarAppearanceUpdate()
                }
            }
        }
    }
    print("[ContentView] Đã kích hoạt hoãn cử chỉ vuốt đáy (chống vuốt thoát app)")
}

extension UIViewController {
    @objc func swizzled_preferredScreenEdgesDeferringSystemGestures() -> UIRectEdge {
        return [.bottom, .all]
    }

    @objc func swizzled_prefersHomeIndicatorAutoHidden() -> Bool {
        return true
    }
}
