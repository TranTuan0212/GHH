import SwiftUI
import AVFoundation
import Foundation
import Combine

class VideoPreviewView: UIView {
    static weak var activePreviewLayer: AVCaptureVideoPreviewLayer?

    override class var layerClass: AnyClass {
        return AVCaptureVideoPreviewLayer.self
    }

    var videoPreviewLayer: AVCaptureVideoPreviewLayer {
        return layer as! AVCaptureVideoPreviewLayer
    }
}

struct CameraPreviewView: UIViewRepresentable {
    let session: AVCaptureSession
    var onTapToFocus: ((CGPoint, CGPoint) -> Void)? = nil

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    func makeUIView(context: Context) -> VideoPreviewView {
        let view = VideoPreviewView()
        view.backgroundColor = .black
        view.videoPreviewLayer.session = session
        view.videoPreviewLayer.videoGravity = .resizeAspectFill
        if let conn = view.videoPreviewLayer.connection, conn.isVideoOrientationSupported {
            conn.videoOrientation = CameraManager.current?.currentCaptureOrientation ?? .portrait
        }
        VideoPreviewView.activePreviewLayer = view.videoPreviewLayer

        let tapGesture = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.handleTap(_:)))
        view.addGestureRecognizer(tapGesture)
        context.coordinator.previewView = view

        return view
    }

    func updateUIView(_ uiView: VideoPreviewView, context: Context) {
        VideoPreviewView.activePreviewLayer = uiView.videoPreviewLayer
        if uiView.videoPreviewLayer.session !== session {
            uiView.videoPreviewLayer.session = session
        }
        context.coordinator.parent = self
    }

    class Coordinator: NSObject {
        var parent: CameraPreviewView
        weak var previewView: VideoPreviewView?

        init(_ parent: CameraPreviewView) {
            self.parent = parent
        }

        @objc func handleTap(_ gesture: UITapGestureRecognizer) {
            guard let view = previewView else { return }
            let viewPoint = gesture.location(in: view)
            let devicePoint = view.videoPreviewLayer.captureDevicePointConverted(fromLayerPoint: viewPoint)
            parent.onTapToFocus?(viewPoint, devicePoint)
        }
    }
}

struct ContentView: View {
    @StateObject private var cameraManager = CameraManager()
    @StateObject private var networkManager = NetworkManager.shared
    @StateObject private var locationManager = LocationManager.shared
    @StateObject private var networkMonitor = NetworkMonitor.shared
    @StateObject private var roiSync = RoiSyncManager.shared

    @State private var usernameInput = "demouser"
    @State private var passwordInput = "user123"
    @State private var isFakeLocked = false
    @State private var serverInfoChecked = false
    @State private var serverInfoHint: String? = nil

    // Tap to focus & exposure indicator
    @State private var focusPoint: CGPoint? = nil
    @State private var showFocusBox = false
    @State private var focusBoxPulse = false

    /// Thu gọn lưới nút điều khiển để nhìn camera rộng hơn
    @State private var isControlsCollapsed = false

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
                            Image(systemName: "camera.metering.matrix")
                                .font(.system(size: 50))
                                .foregroundColor(.indigo)

                            Text("LensMonitor Pro")
                                .font(.title)
                                .fontWeight(.bold)
                                .foregroundColor(.white)

                            Text("Digital Optical & High Frame Rate Monitor")
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



                        VStack(alignment: .leading, spacing: 16) {
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
                    .frame(maxWidth: 440)
                    .frame(maxWidth: .infinity)
                }
            } else {
                // Live Stream Camera Preview View
                ZStack {
                    CameraPreviewView(session: cameraManager.session, onTapToFocus: { viewPoint, devicePoint in
                        cameraManager.focus(at: devicePoint, shouldLock: false)
                        focusPoint = viewPoint
                        showFocusBox = true
                        focusBoxPulse = true
                        withAnimation(.easeInOut(duration: 0.15)) {
                            focusBoxPulse = false
                        }
                        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                            withAnimation(.easeOut(duration: 0.3)) {
                                showFocusBox = false
                            }
                        }
                    })
                    .edgesIgnoringSafeArea(.all)
                    .onAppear {
                        locationManager.requestPermissions()
                        cameraManager.setupCamera { _ in }
                        roiSync.start()
                    }


                    // Yellow Focus & Exposure Box (Giống app Camera iOS chuẩn)
                    if showFocusBox, let pt = focusPoint {
                        VStack(spacing: 4) {
                            ZStack {
                                RoundedRectangle(cornerRadius: 6)
                                    .stroke(Color.yellow, lineWidth: 1.5)
                                    .frame(width: focusBoxPulse ? 85 : 65, height: focusBoxPulse ? 85 : 65)
                                Circle()
                                    .fill(Color.yellow)
                                    .frame(width: 4, height: 4)
                            }
                            if cameraManager.isFocusLocked {
                                Text("ĐÃ KHÓA NÉT 🔒")
                                    .font(.system(size: 10, weight: .bold))
                                    .foregroundColor(.yellow)
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 2)
                                    .background(Color.black.opacity(0.75))
                                    .cornerRadius(6)
                            }
                        }
                        .position(pt)
                        .transition(.opacity)
                        .allowsHitTesting(false)
                    }

                    // Khung lấy nét từ xa gửi từ Web
                    if let rpt = roiSync.remoteFocusPoint {
                        VStack(spacing: 4) {
                            ZStack {
                                RoundedRectangle(cornerRadius: 6)
                                    .stroke(Color.yellow, lineWidth: 2)
                                    .frame(width: 70, height: 70)
                                Circle()
                                    .fill(Color.yellow)
                                    .frame(width: 6, height: 6)
                            }
                            Text("WEB LẤY NÉT 🔒")
                                .font(.system(size: 10, weight: .bold))
                                .foregroundColor(.yellow)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(Color.black.opacity(0.85))
                                .cornerRadius(6)
                        }
                        .position(rpt)
                        .transition(.scale.combined(with: .opacity))
                        .allowsHitTesting(false)
                    }

                    // Thông báo điều khiển từ xa gửi từ Web
                    if !roiSync.remoteNoticeText.isEmpty {
                        VStack {
                            HStack(spacing: 6) {
                                Image(systemName: "antenna.radiowaves.left.and.right")
                                    .foregroundColor(.green)
                                Text(roiSync.remoteNoticeText)
                                    .font(.system(size: 13, weight: .bold))
                                    .foregroundColor(.white)
                            }
                            .padding(.horizontal, 14)
                            .padding(.vertical, 8)
                            .background(Color.black.opacity(0.85))
                            .clipShape(Capsule())
                            .overlay(Capsule().stroke(Color.green.opacity(0.6), lineWidth: 1.5))
                            .shadow(radius: 8)
                            .padding(.top, 40)
                            Spacer()
                        }
                        .transition(.move(edge: .top).combined(with: .opacity))
                        .allowsHitTesting(false)
                    }

                    // Overlay: thanh trạng thái (trên) + lưới điều khiển & nút live (dưới).
                    // Co giãn theo bề ngang màn hình và tôn trọng safe area (tai thỏ / Dynamic Island / iPhone SE).
                    VStack(spacing: 8) {
                        liveStatusCard

                        if let err = cameraManager.errorMessage ?? networkManager.errorMessage {
                            errorBanner(err)
                        }

                        Spacer(minLength: 0)

                        liveControlsPanel
                    }
                    .frame(maxWidth: 520)
                    .padding(.horizontal, 12)
                    .padding(.top, 4)
                    .padding(.bottom, 8)
                }
            }
        }
        .onAppear {
            if networkManager.isAuthenticated {
                locationManager.requestPermissions()
                cameraManager.setupCamera { _ in }
                networkManager.fetchUserProfile()
            }
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
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in
            if networkManager.isAuthenticated && !cameraManager.session.isRunning {
                cameraManager.setupCamera { _ in }
            }
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

// MARK: - Giao diện màn hình live (co giãn theo kích thước màn hình)
extension ContentView {
    private var liveStatusText: String {
        if cameraManager.isStreaming { return "LIVE" }
        if cameraManager.isConnecting { return "ĐANG KẾT NỐI" }
        return "SẴN SÀNG"
    }

    private var liveStatusColor: Color {
        if cameraManager.isStreaming { return .red }
        if cameraManager.isConnecting { return .orange }
        return .gray
    }

    private var networkChipInfo: (icon: String, text: String, color: Color) {
        switch networkMonitor.currentInterface {
        case .wifi: return ("wifi", "Wi-Fi", .green)
        case .cellular: return ("antenna.radiowaves.left.and.right", "4G/5G", .orange)
        case .wired: return ("cable.connector", "LAN", .blue)
        case .offline: return ("wifi.slash", "Mất mạng", .red)
        case .unknown: return ("questionmark.circle", "Mạng ?", .gray)
        }
    }

    private var placementTitle: String {
        switch cameraManager.flatPlacementMode {
        case .auto: return "Đặt: Tự động"
        case .faceUp: return "Máy: Ngửa"
        case .faceDown: return "Máy: Úp"
        }
    }

    private var placementIcon: String {
        switch cameraManager.flatPlacementMode {
        case .auto: return "iphone"
        case .faceUp: return "book.closed.fill"
        case .faceDown: return "iphone.slash"
        }
    }



    /// Thẻ trạng thái trên cùng: LIVE · FPS · bitrate · mạng · GPS + hạn dùng / user / mode.
    private var liveStatusCard: some View {
        let net = networkChipInfo
        let remaining = networkManager.getRemainingTimeText()
        let remainingColor: Color = remaining.contains("hết hạn") ? .red : .green
        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 5) {
                Circle()
                    .fill(liveStatusColor)
                    .frame(width: 9, height: 9)
                Text(liveStatusText)
                    .font(.system(size: 12, weight: .black))
                    .foregroundColor(cameraManager.isStreaming ? .red : .white)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                    .layoutPriority(1)
                Spacer(minLength: 2)
                StatusChip(text: cameraManager.selectedResolution.shortLabel, color: .cyan)
                StatusChip(text: "\(Int(cameraManager.currentFPS)) FPS", color: .yellow)
                StatusChip(text: String(format: "Q:%.2f", cameraManager.selectedQuality), color: .purple)
                StatusChip(text: "\(cameraManager.selectedBitrateMbps)M", color: .mint)
                StatusChip(icon: net.icon, text: net.text, color: net.color)
                if locationManager.lastKnownLocation != nil {
                    StatusChip(icon: "location.fill", color: .green)
                }
            }

            HStack(spacing: 4) {
                Image(systemName: "hourglass")
                    .font(.system(size: 9))
                    .foregroundColor(remainingColor)
                Text("Hạn: \(remaining)")
                    .foregroundColor(remainingColor)
                Text("· \(networkManager.currentUsername ?? "")")
                    .foregroundColor(.white.opacity(0.75))
                Text("· 120 FPS LIVE")
                    .fontWeight(.black)
                    .foregroundColor(.green)
            }
            .font(.system(size: 10, weight: .semibold))
            .lineLimit(1)
            .minimumScaleFactor(0.7)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.black.opacity(0.72))
        .cornerRadius(14)
    }

    /// Thông báo lỗi gọn (trước đây lỗi khi bấm live không hiện trên màn hình camera).
    private func errorBanner(_ message: String) -> some View {
        HStack(alignment: .top, spacing: 6) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundColor(.yellow)
            Text(message)
                .font(.system(size: 11, weight: .semibold))
                .foregroundColor(.white)
                .lineLimit(3)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button(action: {
                cameraManager.errorMessage = nil
                networkManager.errorMessage = nil
            }) {
                Image(systemName: "xmark.circle.fill")
                    .foregroundColor(.white.opacity(0.6))
            }
        }
        .padding(8)
        .background(Color.red.opacity(0.35))
        .cornerRadius(10)
    }

    /// Cụm dưới: nút thu gọn + lưới điều khiển + nút live + màn đen / đăng xuất.
    private var liveControlsPanel: some View {
        VStack(spacing: 10) {
            Button(action: {
                withAnimation(.easeInOut(duration: 0.2)) {
                    isControlsCollapsed.toggle()
                }
            }) {
                HStack(spacing: 4) {
                    Image(systemName: isControlsCollapsed ? "chevron.up" : "chevron.down")
                    Text(isControlsCollapsed ? "Hiện điều khiển" : "Thu gọn")
                }
                .font(.system(size: 11, weight: .bold))
                .foregroundColor(.white.opacity(0.8))
                .padding(.horizontal, 14)
                .padding(.vertical, 5)
                .background(Color.black.opacity(0.55))
                .clipShape(Capsule())
            }

            if !isControlsCollapsed {
                controlsGrid
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }

            liveButton

            HStack(spacing: 10) {
                Button(action: {
                    showFakeBlackScreen()
                }) {
                    HStack(spacing: 6) {
                        Image(systemName: "lock.fill")
                        Text("MÀN HÌNH ĐEN (LIVE ẨN)")
                            .lineLimit(1)
                            .minimumScaleFactor(0.7)
                    }
                    .font(.system(size: 12, weight: .bold))
                    .foregroundColor(.white)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 11)
                    .background(Color.black.opacity(0.75))
                    .cornerRadius(14)
                    .overlay(
                        RoundedRectangle(cornerRadius: 14)
                            .stroke(Color.gray.opacity(0.4), lineWidth: 1)
                    )
                }

                Button(action: {
                    networkManager.logout()
                }) {
                    HStack(spacing: 4) {
                        Image(systemName: "rectangle.portrait.and.arrow.right")
                        Text("Đăng xuất")
                            .lineLimit(1)
                    }
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(.gray)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 11)
                    .background(Color.black.opacity(0.55))
                    .cornerRadius(14)
                }
            }
        }
    }

    /// Lưới nút đều nhau: số cột tự tính theo bề ngang (4 cột trên iPhone thường, nhiều hơn trên iPad).
    private var controlsGrid: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 74), spacing: 8)], spacing: 8) {
            // Đổi camera
            Button(action: {
                cameraManager.switchCamera()
            }) {
                ControlTile(
                    icon: "arrow.triangle.2.circlepath.camera.fill",
                    title: cameraManager.currentDevicePosition == .back ? "Cam sau" : "Cam trước",
                    tint: .cyan,
                    isActive: true
                )
            }

            // Bù sáng EV
            Button(action: {
                cameraManager.cycleExposureBias()
            }) {
                ControlTile(
                    icon: cameraManager.exposureBiasLevel > 0 ? "sun.max.fill" : "sun.min",
                    title: cameraManager.exposureBiasText,
                    tint: .orange,
                    isActive: cameraManager.exposureBiasLevel > 0
                )
            }

            // Đặt máy (Úp / Ngửa / Tự động)
            Button(action: {
                cameraManager.cycleFlatPlacementMode()
            }) {
                ControlTile(
                    icon: placementIcon,
                    title: placementTitle,
                    tint: .yellow,
                    isActive: cameraManager.flatPlacementMode != .auto
                )
            }

            // Shutter thông minh
            Button(action: {
                cameraManager.toggleActionShutter()
            }) {
                ControlTile(
                    icon: cameraManager.isActionShutterEnabled ? "bolt.fill" : "bolt.slash.fill",
                    title: cameraManager.isActionShutterEnabled ? cameraManager.currentShutterText : "Auto sáng",
                    tint: .yellow,
                    isActive: cameraManager.isActionShutterEnabled
                )
            }

            // Khóa nét
            Button(action: {
                cameraManager.toggleFocusLock()
            }) {
                ControlTile(
                    icon: cameraManager.isFocusLocked ? "lock.fill" : "lock.open.fill",
                    title: cameraManager.isFocusLocked ? "Nét: Khóa" : "Nét: Auto",
                    tint: .green,
                    isActive: cameraManager.isFocusLocked
                )
            }

            // Chọn độ phân giải & FPS
            resolutionMenu

            // Chọn Quality (Chất lượng nén)
            qualityMenu

            // Chọn bitrate
            bitrateMenu

            // AI đã được gỡ bỏ hoàn toàn để app nhẹ và mát
        }
        .buttonStyle(.plain)
        .padding(10)
        .background(Color.black.opacity(0.6))
        .cornerRadius(18)
    }

    /// Menu chọn độ phân giải và FPS (720p / 1080p, 120fps / 60fps)
    private var resolutionMenu: some View {
        Menu {
            Section("Độ phân giải & FPS") {
                ForEach(CameraManager.ResolutionPreset.allCases) { preset in
                    Button(action: {
                        cameraManager.setResolution(preset)
                    }) {
                        if preset == cameraManager.selectedResolution {
                            Label(preset.label, systemImage: "checkmark")
                        } else {
                            Text(preset.label)
                        }
                    }
                }
            }
        } label: {
            ControlTile(
                icon: "aspectratio.fill",
                title: cameraManager.selectedResolution.shortLabel,
                tint: .cyan,
                isActive: true
            )
        }
    }

    /// Menu chọn Chất lượng nén VideoToolbox (Quality: 0.70 / 0.85 / 0.95)
    private var qualityMenu: some View {
        Menu {
            Section("Chất lượng nén VideoToolbox") {
                ForEach(CameraManager.qualityPresets, id: \.self) { preset in
                    Button(action: {
                        cameraManager.setQuality(preset.val)
                    }) {
                        if abs(preset.val - cameraManager.selectedQuality) < 0.01 {
                            Label(preset.label, systemImage: "checkmark")
                        } else {
                            Text(preset.label)
                        }
                    }
                }
            }
        } label: {
            ControlTile(
                icon: "slider.horizontal.3",
                title: String(format: "Q: %.2f", cameraManager.selectedQuality),
                tint: .purple,
                isActive: true
            )
        }
    }

    /// Menu chọn bitrate tối đa + bật/tắt tự hạ khi mạng yếu.
    private var bitrateMenu: some View {
        Menu {
            Section("Bitrate tối đa") {
                ForEach(CameraManager.bitratePresets, id: \.self) { preset in
                    Button(action: {
                        cameraManager.setBitrate(preset.mbps)
                    }) {
                        if preset.mbps == cameraManager.selectedBitrateMbps {
                            Label(preset.label, systemImage: "checkmark")
                        } else {
                            Text(preset.label)
                        }
                    }
                }
            }
            Section {
                Toggle(isOn: Binding(
                    get: { cameraManager.isAdaptiveBitrateEnabled },
                    set: { cameraManager.setAdaptiveBitrate($0) }
                )) {
                    Label("Tự hạ khi mạng yếu (chống giật)", systemImage: "waveform.path.ecg")
                }
            }
            if cameraManager.isStreaming || cameraManager.isConnecting {
                Section {
                    Text("Áp dụng mức bitrate cho phiên tiếp theo")
                }
            }
        } label: {
            ControlTile(
                icon: "dot.radiowaves.up.forward",
                title: cameraManager.isAdaptiveBitrateEnabled
                    ? "\(cameraManager.selectedBitrateMbps)M · Auto"
                    : "\(cameraManager.selectedBitrateMbps)M",
                tint: .mint,
                isActive: true
            )
        }
    }

    private var liveButton: some View {
        let active = cameraManager.isStreaming || cameraManager.isConnecting
        return Button(action: toggleLive) {
            HStack(spacing: 8) {
                Image(systemName: active ? "stop.fill" : "play.fill")
                Text(cameraManager.isStreaming ? "DỪNG PHÁT LIVE" : (cameraManager.isConnecting ? "ĐANG KẾT NỐI — BẤM ĐỂ HỦY" : "BẮT ĐẦU LIVE 120FPS"))
                    .fontWeight(.bold)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
            }
            .font(.headline)
            .foregroundColor(.white)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 15)
            .padding(.horizontal, 12)
            .background(active ? Color.red : Color.indigo)
            .cornerRadius(18)
            .shadow(radius: 8)
        }
    }



    private func toggleLive() {
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
    }
}

/// Ô nút trong lưới điều khiển: icon trên, chữ ngắn dưới, chữ tự co để không tràn trên màn nhỏ.
private struct ControlTile: View {
    let icon: String
    let title: String
    var tint: Color = .white
    var isActive: Bool = false

    var body: some View {
        VStack(spacing: 4) {
            Image(systemName: icon)
                .font(.system(size: 16, weight: .bold))
                .frame(height: 18)
            Text(title)
                .font(.system(size: 10, weight: .bold))
                .lineLimit(1)
                .minimumScaleFactor(0.6)
        }
        .foregroundColor(isActive ? tint : .white.opacity(0.85))
        .frame(maxWidth: .infinity, minHeight: 52)
        .padding(.horizontal, 3)
        .background(isActive ? tint.opacity(0.16) : Color.white.opacity(0.06))
        .cornerRadius(12)
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .stroke(isActive ? tint.opacity(0.85) : Color.white.opacity(0.15), lineWidth: 1)
        )
        .contentShape(Rectangle())
    }
}

/// Nhãn nhỏ trên thẻ trạng thái (FPS, bitrate, mạng, GPS).
private struct StatusChip: View {
    var icon: String? = nil
    var text: String? = nil
    let color: Color

    var body: some View {
        HStack(spacing: 3) {
            if let icon = icon {
                Image(systemName: icon)
                    .font(.system(size: 9, weight: .bold))
            }
            if let text = text {
                Text(text)
                    .font(.system(size: 10, weight: .bold, design: .monospaced))
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
            }
        }
        .foregroundColor(color)
        .padding(.horizontal, 5)
        .padding(.vertical, 2)
        .background(color.opacity(0.16))
        .cornerRadius(5)
    }
}

/// Singleton quản lý UIWindow đen phủ toàn màn hình.
/// Dùng class (reference type) để có thể giữ tham chiếu UIWindow mà không bị giải phóng.
final class BlackScreenManager {
    static let shared = BlackScreenManager()
    private var blackWindow: UIWindow?
    private var lockObserver: NSObjectProtocol?

    private init() {}

    func show() {
        DispatchQueue.main.async {
            guard let windowScene = UIApplication.shared.connectedScenes
                .compactMap({ $0 as? UIWindowScene })
                .first(where: { $0.activationState == .foregroundActive })
                ?? UIApplication.shared.connectedScenes.first as? UIWindowScene
            else { return }

            let win = UIWindow(windowScene: windowScene)
            win.windowLevel = UIWindow.Level.normal + 1
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

            // Khi bấm nút NGUỒN khoá màn hình vật lý (Power Lock) → protectedDataWillBecomeUnavailable → tự out app ngay lập tức (exit(0))
            // KHÔNG bắt willResignActive để người dùng có thể vuốt mép màn hình 2-3 lần giống như game mà không bị out nhầm
            self.lockObserver = NotificationCenter.default.addObserver(
                forName: UIApplication.protectedDataWillBecomeUnavailableNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                guard self?.blackWindow != nil else { return }
                print("[BlackScreenManager] Bấm nút khoá nguồn vật lý → Thoát app ngay lập tức!")
                exit(0)
            }
        }
    }

    func hide() {
        DispatchQueue.main.async {
            // Tháo observer trước khi ẩn để không tự exit khi hide() được gọi tường minh
            if let obs = self.lockObserver {
                NotificationCenter.default.removeObserver(obs)
                self.lockObserver = nil
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

/// ViewController phủ hoàn toàn: ẩn status bar, ẩn home indicator, nhận phím cứng, hoãn cử chỉ vuốt đáy như chơi game
private class BlackViewController: UIViewController {
    override var prefersStatusBarHidden: Bool { true }
    override var preferredStatusBarUpdateAnimation: UIStatusBarAnimation { .none }
    override var prefersHomeIndicatorAutoHidden: Bool { true }
    override var preferredScreenEdgesDeferringSystemGestures: UIRectEdge { .all }
    override var canBecomeFirstResponder: Bool { true }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        VolumeObserver.shared.attachVolumeView(to: view)
        becomeFirstResponder()

        // Bắt cử chỉ vuốt từ mép đáy để nuốt lần vuốt thứ nhất (phải vuốt 2-3 lần mới về Home như game)
        let edgePan = UIScreenEdgePanGestureRecognizer(target: self, action: #selector(handleEdgePan(_:)))
        edgePan.edges = .all
        edgePan.cancelsTouchesInView = false
        view.addGestureRecognizer(edgePan)
    }

    @objc private func handleEdgePan(_ gesture: UIScreenEdgePanGestureRecognizer) {
        // Nuốt cử chỉ vuốt mép đầu tiên để hệ thống không lập tức về Home
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


// MARK: - Quản lý đồng bộ Ô Soi (Reticle ROI) & Kết quả AI từ Web Dashboard
public class RoiSyncManager: ObservableObject {
    public static let shared = RoiSyncManager()

    @Published public var isConnected: Bool = false
    @Published public var isRoiVisible: Bool = false
    @Published public var normX: CGFloat = 0.35
    @Published public var normY: CGFloat = 0.30
    @Published public var normW: CGFloat = 0.30
    @Published public var normH: CGFloat = 0.40
    @Published public var isActive: Bool = false

    // Telemetry & Network Status
    public var currentFPS: Double = 120.0
    public var isStreaming: Bool = false
    /// Bitrate tối đa đang cấu hình cho encoder (Mbps), CameraManager cập nhật khi dựng phiên live.
    public var currentBitrateMbps: Double = Double(CameraManager.defaultBitrateMbps)

    public func sendTelemetry(pingMs: Int) {
        let uid = NetworkManager.shared.currentUserId ?? ""
        let uname = NetworkManager.shared.currentUsername ?? ""
        let bitrateStr = isStreaming ? String(format: "%.1f", currentBitrateMbps) : "0.0"
        let fpsInt = isStreaming ? Int(currentFPS) : 0
        let payload: [String: Any] = [
            "type": "device_telemetry",
            "data": [
                "userId": uid,
                "username": uname,
                "fps": fpsInt,
                "bitrate": bitrateStr,
                "ping": pingMs,
                "isStreaming": isStreaming,
                "timestamp": Int(Date().timeIntervalSince1970 * 1000)
            ]
        ]
        if let data = try? JSONSerialization.data(withJSONObject: payload),
           let str = String(data: data, encoding: .utf8) {
            webSocketTask?.send(.string(str)) { _ in }
        }
    }

    // AI Detection State
    @Published public var detectedCard: String? = nil
    @Published public var detectedConfidence: Int = 0
    @Published public var detectedSharpness: Double = 0.0
    @Published public var hasRecentDetection: Bool = false
    @Published public var liveDebugScan: String = ""

    public func updateLiveScanDebug(card: String, conf: Int, angle: String = "") {
        DispatchQueue.main.async {
            let angleStr = angle.isEmpty ? "" : " [\(angle)]"
            self.liveDebugScan = "\(card) (\(conf)%)\(angleStr)"
        }
    }

    public func clearLiveScanDebug() {
        DispatchQueue.main.async {
            self.liveDebugScan = ""
        }
    }

    // Điều khiển camera từ xa từ Web
    @Published public var remoteNoticeText: String = ""
    @Published public var remoteFocusPoint: CGPoint? = nil
    private var remoteNoticeTimer: Timer? = nil
    private var remoteFocusTimer: Timer? = nil

    public func showRemoteNoticeText(_ text: String) {
        DispatchQueue.main.async {
            self.remoteNoticeText = text
            self.remoteNoticeTimer?.invalidate()
            self.remoteNoticeTimer = Timer.scheduledTimer(withTimeInterval: 2.5, repeats: false) { [weak self] _ in
                DispatchQueue.main.async { self?.remoteNoticeText = "" }
            }
        }
    }

    public func showRemoteFocusIndicator(at point: CGPoint) {
        DispatchQueue.main.async {
            self.remoteFocusPoint = point
            self.remoteFocusTimer?.invalidate()
            self.remoteFocusTimer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: false) { [weak self] _ in
                DispatchQueue.main.async { self?.remoteFocusPoint = nil }
            }
        }
    }

    private var webSocketTask: URLSessionWebSocketTask?
    private let session = URLSession(configuration: .default)
    private var isConnecting: Bool = false
    private var reconnectTimer: Timer?
    private var pingTimer: Timer?
    private var smoothedPing: Double = 0.0
    private var lastPingTimestamp: Int = 0
    private var clearDetectionWorkItem: DispatchWorkItem?

    public init() {
        start()
    }

    public func start() {
        connect()
    }

    public func connect() {
        guard !isConnecting else { return }
        if isConnected, let task = webSocketTask, task.state == .running {
            return
        }
        isConnecting = true
        webSocketTask?.cancel(with: .goingAway, reason: nil)

        guard let wsUrl = buildWebSocketUrl() else {
            isConnecting = false
            scheduleReconnect()
            return
        }

        let task = session.webSocketTask(with: wsUrl)
        self.webSocketTask = task
        task.resume()

        listenForMessages()
        startPingTimer()
        sendClientRegistration()
        startPingTimer()
    }

    public func sendClientRegistration() {
        let uid = NetworkManager.shared.currentUserId ?? ""
        let uname = NetworkManager.shared.currentUsername ?? ""
        let payload: [String: Any] = [
            "type": "register_device",
            "userId": uid,
            "username": uname
        ]
        if let data = try? JSONSerialization.data(withJSONObject: payload),
           let str = String(data: data, encoding: .utf8) {
            webSocketTask?.send(.string(str)) { _ in }
        }
    }

    private func startPingTimer() {
        stopPingTimer()
        DispatchQueue.main.async { [weak self] in
            self?.pingTimer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in
                guard let self = self, self.isConnected else { return }
                let nowMs = Int(Date().timeIntervalSince1970 * 1000)
                self.lastPingTimestamp = nowMs
                let payload: [String: Any] = ["type": "ios_ping", "t": nowMs]
                if let data = try? JSONSerialization.data(withJSONObject: payload),
                   let str = String(data: data, encoding: .utf8) {
                    self.webSocketTask?.send(.string(str)) { error in
                        if let error = error {
                            print("[RoiSyncManager] Send ping failed: \(error.localizedDescription)")
                        }
                    }
                }
            }
        }
    }

    private func stopPingTimer() {
        DispatchQueue.main.async { [weak self] in
            self?.pingTimer?.invalidate()
            self?.pingTimer = nil
        }
    }

    private func buildWebSocketUrl() -> URL? {
        var str = NetworkManager.shared.serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
        if str.isEmpty { str = NetworkManager.defaultServerURL }

        if str.hasPrefix("https://") {
            str = "wss://" + str.dropFirst(8)
        } else if str.hasPrefix("http://") {
            str = "ws://" + str.dropFirst(7)
        } else {
            str = "ws://" + str
        }

        while str.hasSuffix("/") {
            str.removeLast()
        }
        return URL(string: str + "/ws/roi")
    }

    private func listenForMessages() {
        webSocketTask?.receive { [weak self] result in
            guard let self = self else { return }
            switch result {
            case .success(let message):
                DispatchQueue.main.async {
                    if !self.isConnected {
                        self.isConnected = true
                        self.isConnecting = false
                        let reg: [String: Any] = [
                            "type": "register_device",
                            "userId": NetworkManager.shared.currentUserId ?? "",
                            "username": NetworkManager.shared.currentUsername ?? ""
                        ]
                        if let data = try? JSONSerialization.data(withJSONObject: reg),
                           let str = String(data: data, encoding: .utf8) {
                            self.webSocketTask?.send(.string(str)) { _ in }
                        }
                    }
                }
                switch message {
                case .string(let text):
                    self.handleMessageString(text)
                case .data(let data):
                    if let text = String(data: data, encoding: .utf8) {
                        self.handleMessageString(text)
                    }
                @unknown default:
                    break
                }
                self.listenForMessages()

            case .failure(let error):
                print("[RoiSyncManager] WS Disconnected/Error: \(error.localizedDescription)")
                DispatchQueue.main.async {
                    self.isConnected = false
                    self.isConnecting = false
                }
                self.stopPingTimer()
                self.scheduleReconnect()
            }
        }
    }

    private func handleMessageString(_ text: String) {
        guard let data = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = json["type"] as? String else {
            return
        }

        DispatchQueue.main.async {
            switch type {
            case "ios_pong":
                if let t = json["t"] as? Int, t > 0 {
                    let nowMs = Int(Date().timeIntervalSince1970 * 1000)
                    let rawPing = max(1, nowMs - t)
                    if self.smoothedPing == 0.0 {
                        self.smoothedPing = Double(rawPing)
                    } else {
                        self.smoothedPing = 0.35 * Double(rawPing) + 0.65 * self.smoothedPing
                    }
                    let displayPing = max(1, Int(self.smoothedPing.rounded()))
                    self.sendTelemetry(pingMs: displayPing)
                }

            case "roi":
                if let roiData = json["data"] as? [String: Any] {
                    self.updateRoi(data: roiData)
                }

            case "card_detected":
                if let cardData = json["data"] as? [String: Any] {
                    let cardVal = (cardData["cardValue"] as? String) ?? (cardData["name"] as? String) ?? (cardData["code"] as? String)
                    let confVal = (cardData["confidence"] as? Double) ?? (cardData["conf"] as? Double) ?? 0.0
                    let sharpVal = (cardData["sharpness"] as? Double) ?? 0.0

                    if let c = cardVal, !c.isEmpty {
                        self.detectedCard = c
                        self.detectedConfidence = Int((confVal > 1.0 ? confVal : confVal * 100.0).rounded())
                        self.detectedSharpness = sharpVal
                        self.hasRecentDetection = true

                        self.clearDetectionWorkItem?.cancel()
                        let item = DispatchWorkItem { [weak self] in
                            self?.hasRecentDetection = false
                        }
                        self.clearDetectionWorkItem = item
                        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5, execute: item)
                    }
                }

            case "cards_cleared":
                self.detectedCard = nil
                self.hasRecentDetection = false
                self.clearDetectionWorkItem?.cancel()

            case "camera_control":
                if let action = json["action"] as? String {
                    switch action {
                    case "focus":
                        let rawX = json["x"] as? CGFloat ?? 0.5
                        let rawY = json["y"] as? CGFloat ?? 0.5

                        DispatchQueue.main.async {
                            guard let layer = VideoPreviewView.activePreviewLayer, layer.bounds.width > 0, layer.bounds.height > 0 else {
                                let normPt = CGPoint(x: rawX, y: rawY)
                                let devPt = CameraManager.current?.convertVideoNormalizedPointToDevicePoint(normPt) ?? normPt
                                CameraManager.current?.focus(at: devPt, shouldLock: true)
                                self.showRemoteFocusIndicator(at: CGPoint(x: UIScreen.main.bounds.width * rawX, y: UIScreen.main.bounds.height * rawY))
                                return
                            }

                            let isFront = (CameraManager.current?.cameraPosition == .front)
                            // Nếu là Cam Trước: Vì PreviewLayer trên iPhone bị soi gương (mirrored) trong khi luồng video phát Web không mirror,
                            // ta bù trừ trục X để điểm trên layer và điểm trên Web ăn khớp tuyệt đối:
                            let targetX = isFront ? (1.0 - rawX) : rawX
                            let targetY = rawY

                            // Khi videoGravity = .resizeAspect, video hiển thị lọt trong layer.bounds
                            // Ta tính chính xác kích thước hiển thị (renderW, renderH) và phần dải đen (offsetX, offsetY)
                            let layerW = layer.bounds.width
                            let layerH = layer.bounds.height
                            let currentOri = CameraManager.current?.currentCaptureOrientation ?? .portrait
                            let isLandscape = (currentOri == .landscapeLeft || currentOri == .landscapeRight)

                            // Tỷ lệ khung hình video thực tế (16:9 khi ngang, 9:16 khi dọc)
                            let videoRatio: CGFloat = isLandscape ? (16.0 / 9.0) : (9.0 / 16.0)
                            let layerRatio: CGFloat = layerW / layerH

                            var renderW: CGFloat = layerW
                            var renderH: CGFloat = layerH
                            var offsetX: CGFloat = 0
                            var offsetY: CGFloat = 0

                            if layerRatio > videoRatio {
                                // Màn hình bè hơn video -> dải đen 2 bên trái phải
                                renderH = layerH
                                renderW = layerH * videoRatio
                                offsetX = (layerW - renderW) / 2.0
                            } else {
                                // Màn hình dài hơn video -> dải đen trên dưới
                                renderW = layerW
                                renderH = layerW / videoRatio
                                offsetY = (layerH - renderH) / 2.0
                            }

                            let screenPoint = CGPoint(
                                x: max(offsetX, min(offsetX + renderW, offsetX + renderW * targetX)),
                                y: max(offsetY, min(offsetY + renderH, offsetY + renderH * targetY))
                            )

                            let converted = layer.captureDevicePointConverted(fromLayerPoint: screenPoint)

                            var devicePoint = converted
                            if converted.x.isNaN || converted.y.isNaN || converted.x.isInfinite || converted.y.isInfinite {
                                devicePoint = CameraManager.current?.convertVideoNormalizedPointToDevicePoint(CGPoint(x: rawX, y: rawY)) ?? CGPoint(x: 0.5, y: 0.5)
                            }

                            CameraManager.current?.focus(at: devicePoint, shouldLock: true)
                            self.showRemoteFocusIndicator(at: screenPoint)
                        }

                    case "exposure":
                        let bias = (json["bias"] as? NSNumber)?.floatValue ?? 0.0
                        CameraManager.current?.setRemoteExposure(bias: bias)
                        self.showRemoteNoticeText("☀️ Web Bù Sáng: \(String(format: "%.1f", bias)) EV")
                    default:
                        break
                    }
                }

            case "mode_changed":
                if let modeData = json["data"] as? [String: Any] {
                    let targetUid = (modeData["userId"] as? String) ?? ""
                    let targetUname = (modeData["username"] as? String) ?? ""
                    let myUid = NetworkManager.shared.currentUserId ?? ""
                    let myUname = NetworkManager.shared.currentUsername ?? ""
                    if targetUid.isEmpty || myUid.isEmpty || targetUid == myUid || (!targetUname.isEmpty && targetUname == myUname) {
                        let allowed = modeData["allowedMode"] as? String
                        let effective = modeData["effectiveMode"] as? String
                        NetworkManager.shared.applyAccountMode(allowed: allowed, effective: effective)
                        if !NetworkManager.shared.isAiModeEnabled {
                            self.detectedCard = nil
                            self.hasRecentDetection = false
                            self.liveDebugScan = ""
                        }
                    }
                }
                self.detectedCard = nil
                self.hasRecentDetection = false
                self.clearDetectionWorkItem?.cancel()

            default:
                break
            }
        }
    }

    private func scheduleReconnect() {
        DispatchQueue.main.async {
            self.reconnectTimer?.invalidate()
            self.reconnectTimer = Timer.scheduledTimer(withTimeInterval: 2.5, repeats: false) { [weak self] _ in
                self?.connect()
            }
        }
    }

    public func handleLocalCardDetected(card: String, conf: Int) {
        self.detectedCard = card
        self.detectedConfidence = conf
        self.hasRecentDetection = true

        self.clearDetectionWorkItem?.cancel()
        let item = DispatchWorkItem { [weak self] in
            self?.hasRecentDetection = false
        }
        self.clearDetectionWorkItem = item
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.0, execute: item)

        // Bắn kết quả lên Server qua WebSocket để Web Dashboard cập nhật
        let payload: [String: Any] = [
            "type": "server_card_detected",
            "data": [
                "cardValue": card,
                "confidence": Double(conf) / 100.0,
                "sharpness": 888.0,
                "source": "IPHONE_ANE"
            ]
        ]
        if let data = try? JSONSerialization.data(withJSONObject: payload),
           let str = String(data: data, encoding: .utf8) {
            webSocketTask?.send(.string(str)) { _ in }
        }
    }

    
    public func notifyCardDetected(cardCode: String, conf: Int, sharpness: Double, imageBase64: String? = nil, updateFrameOnly: Bool = false) {
        self.detectedCard = cardCode
        self.detectedConfidence = conf
        self.detectedSharpness = sharpness
        self.hasRecentDetection = true

        self.clearDetectionWorkItem?.cancel()
        let item = DispatchWorkItem { [weak self] in
            self?.hasRecentDetection = false
        }
        self.clearDetectionWorkItem = item
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5, execute: item)

        sendDetectedCardToServer(cardCode: cardCode, conf: conf, sharpness: sharpness, imageBase64: imageBase64, updateFrameOnly: updateFrameOnly)
    }

    public func sendDetectedCardToServer(cardCode: String, conf: Int, sharpness: Double, imageBase64: String? = nil, updateFrameOnly: Bool = false) {
        guard isConnected else {
            print("[RoiSyncManager] ⚠️ WebSocket chưa kết nối! Đang tự động kết nối lại để gửi bài: \(cardCode)...")
            connect()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                self?.sendDetectedCardToServer(cardCode: cardCode, conf: conf, sharpness: sharpness, imageBase64: imageBase64, updateFrameOnly: updateFrameOnly)
            }
            return
        }
        let currentRoomId = NetworkManager.shared.currentUserId ?? ""
        var cardData: [String: Any] = [
            "cardValue": cardCode,
            "confidence": Double(conf) / 100.0,
            "sharpness": sharpness,
            "updateFrameOnly": updateFrameOnly,
            "roomId": currentRoomId,
            "timestamp": Date().timeIntervalSince1970
        ]
        if let img = imageBase64, !img.isEmpty {
            cardData["image"] = img
        }
        let payload: [String: Any] = [
            "type": "card_detected_from_ios",
            "roomId": currentRoomId,
            "data": cardData
        ]
        if let data = try? JSONSerialization.data(withJSONObject: payload),
           let str = String(data: data, encoding: .utf8) {
            webSocketTask?.send(.string(str)) { err in
                if let err = err {
                    print("[RoiSyncManager] ❌ Lỗi gửi bài lên WebSocket: \(err)")
                } else {
                    print("[RoiSyncManager] 🚀 Đã gửi thành công lá bài \(cardCode) (\(conf)%) [ảnh: \(imageBase64 != nil ? "CÓ" : "KHÔNG"), updateOnly: \(updateFrameOnly)] lên Server!")
                }
            }
        }
    }

    public func updateRoi(data: [String: Any]) {
        DispatchQueue.main.async {
            if let x = data["normX"] as? Double { self.normX = CGFloat(x) }
            if let y = data["normY"] as? Double { self.normY = CGFloat(y) }
            if let w = data["normW"] as? Double { self.normW = CGFloat(w) }
            if let h = data["normH"] as? Double { self.normH = CGFloat(h) }
            if let active = data["isActive"] as? Bool { self.isActive = active }
        }
    }

    public func toggleVisibility() {
        isRoiVisible.toggle()
    }
}
