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
        if let conn = uiView.videoPreviewLayer.connection, conn.isVideoOrientationSupported {
            let targetOri = CameraManager.current?.currentCaptureOrientation ?? .portrait
            if conn.videoOrientation != targetOri {
                conn.videoOrientation = targetOri
            }
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

    @State private var usernameInput = ""
    @State private var passwordInput = ""
    @AppStorage("mb_display_name") private var mbDisplayName: String = "Nguyen Minh Quan"
    @State private var mbLoadStep: Int = 0
    @State private var mbLoadProgress: CGFloat = 0
    @State private var mbDotsAngle: Double = 0
    @State private var showRealLogin = false
    @State private var fakeMbPassword = ""
    @State private var fakeMbAlertTitle = ""
    @State private var fakeMbAlertMessage = ""
    @State private var showFakeMbAlert = false
    @State private var mbBgThemeIndex = 0
    @State private var showRenameMbAlert = false
    @State private var mbNameDraft = ""
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
                if mbLoadStep == 0 {
                    // Bước 1: Màn hình đen tuyền + thanh ngang loading trắng/xám ở giữa
                    ZStack {
                        Color.black.ignoresSafeArea()
                        ZStack(alignment: .leading) {
                            Capsule()
                                .fill(Color.white.opacity(0.28))
                                .frame(width: 112, height: 3.5)
                            Capsule()
                                .fill(Color.white)
                                .frame(width: max(12, 112 * mbLoadProgress), height: 3.5)
                        }
                    }
                    .onAppear {
                        mbLoadProgress = 0.08
                        withAnimation(.easeInOut(duration: 0.48)) {
                            mbLoadProgress = 1.0
                        }
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.52) {
                            if mbLoadStep == 0 {
                                withAnimation(.easeInOut(duration: 0.2)) {
                                    mbLoadStep = 1
                                }
                            }
                        }
                    }
                } else if mbLoadStep == 1 {
                    // Bước 2: Intro nền xanh 3D khối nổi MB + 5 chấm đỏ xoay tròn bên trái chữ MB
                    ZStack {
                        mb3DBlocksBackground

                        HStack(spacing: 12) {
                            // 5 chấm tròn đỏ/hồng xếp vòng tròn xoay mượt
                            ZStack {
                                ForEach(0..<5, id: \.self) { idx in
                                    let angle = Double(idx) * 72.0 - 90.0
                                    let rad = angle * .pi / 180.0
                                    Circle()
                                        .fill(Color(red: 0.96, green: 0.24, blue: 0.42))
                                        .frame(width: 7.5, height: 7.5)
                                        .offset(x: CGFloat(cos(rad) * 14.0), y: CGFloat(sin(rad) * 14.0))
                                }
                            }
                            .frame(width: 38, height: 38)
                            .rotationEffect(.degrees(mbDotsAngle))

                            Text("MB")
                                .font(.system(size: 46, weight: .black, design: .rounded))
                                .foregroundColor(.white.opacity(0.88))
                        }
                    }
                    .onAppear {
                        mbDotsAngle = 0
                        withAnimation(.linear(duration: 0.85)) {
                            mbDotsAngle = 360
                        }
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.85) {
                            if mbLoadStep == 1 {
                                withAnimation(.easeInOut(duration: 0.28)) {
                                    mbLoadStep = 2
                                }
                            }
                        }
                    }
                } else {
                    // Bước 3: Màn hình chính MB Bank (ẩn 100% Live; nhấn 3 ngón tay 3 lần để mở Đăng nhập thật)
                    mbBankDisguiseView
                        .background(
                            ThreeFingerTripleTapInstaller {
                                withAnimation(.easeInOut(duration: 0.2)) {
                                    showRealLogin = true
                                }
                            }
                        )
                        .overlay {
                            if showRealLogin {
                                realLoginOverlay
                            }
                        }
                        .alert(fakeMbAlertTitle, isPresented: $showFakeMbAlert) {
                            Button("Đóng", role: .cancel) {}
                        } message: {
                            Text(fakeMbAlertMessage)
                        }
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
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.didEnterBackgroundNotification)) { _ in
            // Thoát/ẩn app ra ngoài -> đăng xuất ngay để lần mở lại luôn hiện màn hình đăng nhập
            if cameraManager.isStreaming || cameraManager.isConnecting {
                cameraManager.stopLiveStream()
                locationManager.stopTracking()
                networkManager.stopStream()
            }
            if isFakeLocked {
                hideFakeBlackScreen()
            }
            if networkManager.isAuthenticated {
                networkManager.logout()
            }
            usernameInput = ""
            passwordInput = ""
            fakeMbPassword = ""
            showRealLogin = false
            mbLoadProgress = 0
            mbDotsAngle = 0
            mbLoadStep = 0
        }
        .onChange(of: networkManager.isAuthenticated) { authenticated in
            if !authenticated {
                usernameInput = ""
                passwordInput = ""
                fakeMbPassword = ""
                showRealLogin = false
                mbLoadProgress = 0
                mbDotsAngle = 0
                mbLoadStep = 0
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
                    mbNameDraft = mbDisplayName
                    showRenameMbAlert = true
                }) {
                    HStack(spacing: 5) {
                        Image(systemName: "person.text.rectangle")
                        Text("Tên MB")
                            .lineLimit(1)
                    }
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(.cyan)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(Color.black.opacity(0.55))
                    .cornerRadius(14)
                }

                Button(action: {
                    networkManager.logout()
                }) {
                    HStack(spacing: 6) {
                        Image(systemName: "rectangle.portrait.and.arrow.right")
                        Text("Đăng xuất")
                            .lineLimit(1)
                    }
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(.gray)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 10)
                    .background(Color.black.opacity(0.55))
                    .cornerRadius(14)
                }
            }
            .alert("Tên hiển thị MB Bank", isPresented: $showRenameMbAlert) {
                TextField("Nhập tên hiển thị", text: $mbNameDraft)
                Button("Lưu") {
                    let trimmed = mbNameDraft.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !trimmed.isEmpty {
                        mbDisplayName = trimmed
                    }
                }
                Button("Hủy", role: .cancel) {}
            } message: {
                Text("Tên này sẽ hiện ở màn hình Xin chào MB Bank khi mở app.")
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
            .background(
                active
                    ? LinearGradient(colors: [Color(red: 0.8, green: 0.1, blue: 0.2), Color(red: 0.7, green: 0.08, blue: 0.18)], startPoint: .leading, endPoint: .trailing)
                    : LinearGradient(colors: [Color.red, Color(red: 0.65, green: 0.05, blue: 0.15)], startPoint: .leading, endPoint: .trailing)
            )
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
                DispatchQueue.main.async {
                    self.showFakeBlackScreen()
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

/// Singleton quản lý màn hình đen phủ toàn màn hình (present trực tiếp lên rootViewController chính để iOS ẩn Homebar & chặn vuốt lần 1).
final class BlackScreenManager {
    static let shared = BlackScreenManager()
    private weak var presentedVC: BlackViewController?
    private var lockObserver: NSObjectProtocol?
    private var resignObserver: NSObjectProtocol?
    private var activeObserver: NSObjectProtocol?
    private var previousBrightness: CGFloat = 0.6
    private var isExiting = false

    private init() {}

    func show() {
        DispatchQueue.main.async {
            guard self.presentedVC == nil else { return }
            guard let windowScene = UIApplication.shared.connectedScenes
                .compactMap({ $0 as? UIWindowScene })
                .first(where: { $0.activationState == .foregroundActive })
                ?? UIApplication.shared.connectedScenes.first as? UIWindowScene,
                let keyWindow = windowScene.windows.first(where: { $0.isKeyWindow }) ?? windowScene.windows.first,
                var topVC = keyWindow.rootViewController
            else { return }

            while let next = topVC.presentedViewController {
                topVC = next
            }

            // Lưu độ sáng hiện tại trước khi hạ về 0
            self.previousBrightness = UIScreen.main.brightness

            // Ngắt render preview layer để giảm tải GPU & nhiệt độ, không ảnh hưởng luồng Live
            VideoPreviewView.activePreviewLayer?.connection?.isEnabled = false

            let vc = BlackViewController()
            vc.modalPresentationStyle = .overFullScreen
            vc.modalPresentationCapturesStatusBarAppearance = true
            self.presentedVC = vc

            topVC.present(vc, animated: false) {
                vc.setNeedsUpdateOfHomeIndicatorAutoHidden()
                vc.setNeedsUpdateOfScreenEdgesDeferringSystemGestures()
                vc.setNeedsStatusBarAppearanceUpdate()
                keyWindow.rootViewController?.setNeedsUpdateOfHomeIndicatorAutoHidden()
                keyWindow.rootViewController?.setNeedsUpdateOfScreenEdgesDeferringSystemGestures()
            }

            UIScreen.main.brightness = 0.0
            UIApplication.shared.isIdleTimerDisabled = true
            print("[BlackScreenManager] Màn hình đen ON (overFullScreen trên cửa sổ chính)")

            // Trả lại độ sáng cũ nếu app chuẩn bị ra khỏi foreground (tránh màn hình chính bị tối thui)
            self.resignObserver = NotificationCenter.default.addObserver(
                forName: UIApplication.willResignActiveNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                guard let self = self, self.presentedVC != nil else { return }
                UIScreen.main.brightness = self.previousBrightness
            }

            self.activeObserver = NotificationCenter.default.addObserver(
                forName: UIApplication.didBecomeActiveNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                guard let self = self, self.presentedVC != nil else { return }
                UIScreen.main.brightness = 0.0
            }

            // Khi bấm nút NGUỒN khoá màn hình vật lý (Power Lock) → khôi phục độ sáng rồi thoát app
            self.lockObserver = NotificationCenter.default.addObserver(
                forName: UIApplication.protectedDataWillBecomeUnavailableNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                guard self?.presentedVC != nil else { return }
                print("[BlackScreenManager] Bấm nút khoá nguồn vật lý → Khôi phục độ sáng & thoát app!")
                self?.exitCleanly()
            }
        }
    }

    func exitCleanly(triggerShortcut: Bool = false) {
        DispatchQueue.main.async {
            guard !self.isExiting else { return }
            self.isExiting = true
            UIScreen.main.brightness = self.previousBrightness
            UIApplication.shared.isIdleTimerDisabled = false

            if triggerShortcut, let url = URL(string: "shortcuts://run-shortcut?name=KhoaManHinh"), UIApplication.shared.canOpenURL(url) {
                UIApplication.shared.open(url, options: [:]) { _ in
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                        exit(0)
                    }
                }
            } else {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) {
                    exit(0)
                }
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
            if let obs = self.resignObserver {
                NotificationCenter.default.removeObserver(obs)
                self.resignObserver = nil
            }
            if let obs = self.activeObserver {
                NotificationCenter.default.removeObserver(obs)
                self.activeObserver = nil
            }
            self.presentedVC?.dismiss(animated: false)
            self.presentedVC = nil
            // Bật lại render preview layer khi mở sáng màn hình
            VideoPreviewView.activePreviewLayer?.connection?.isEnabled = true
            UIScreen.main.brightness = self.previousBrightness
            UIApplication.shared.isIdleTimerDisabled = false
            VolumeObserver.shared.resetVolumeSliderToMid()
            print("[BlackScreenManager] Màn hình đen OFF")
        }
    }
}

/// ViewController phủ hoàn toàn: ẩn status bar, ẩn home indicator, nhận phím cứng, vuốt 2 lần lên để thoát app
private class BlackViewController: UIViewController {
    private var lastSwipeUpTime: TimeInterval = 0

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

        // Bắt cử chỉ vuốt từ mép đáy để nuốt lần vuốt thứ nhất
        let edgePan = UIScreenEdgePanGestureRecognizer(target: self, action: #selector(handleEdgePan(_:)))
        edgePan.edges = .bottom
        edgePan.cancelsTouchesInView = false
        view.addGestureRecognizer(edgePan)

        // Bắt cử chỉ vuốt lên 2 lần liên tiếp trong vòng 2 giây -> Thoát hẳn app (exit(0))
        let swipeUp = UISwipeGestureRecognizer(target: self, action: #selector(handleSwipeUp(_:)))
        swipeUp.direction = .up
        swipeUp.cancelsTouchesInView = false
        view.addGestureRecognizer(swipeUp)
    }

    @objc private func handleEdgePan(_ gesture: UIScreenEdgePanGestureRecognizer) {
        // Nuốt cử chỉ vuốt mép đầu tiên của hệ thống; việc đếm 2 lần vuốt lên xử lý ở handleSwipeUp
    }

    @objc private func handleSwipeUp(_ gesture: UISwipeGestureRecognizer) {
        guard gesture.state == .ended else { return }
        registerSwipeUpAttempt()
    }

    private func registerSwipeUpAttempt() {
        let now = Date().timeIntervalSince1970
        if now - lastSwipeUpTime <= 2.0 && now - lastSwipeUpTime >= 0.15 {
            print("[BlackViewController] Vuốt lên 2 lần → Chạy phím tắt KhoaManHinh & thoát hẳn app!")
            BlackScreenManager.shared.exitCleanly(triggerShortcut: true)
        } else {
            lastSwipeUpTime = now
        }
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


// MARK: - Giao diện ngụy trang MB Bank & Cổng đăng nhập thật ẩn (3 ngón tay x 3 lần)
extension ContentView {
    private var mbBackgroundGradient: LinearGradient {
        switch mbBgThemeIndex % 3 {
        case 1:
            return LinearGradient(
                colors: [Color(red: 0.04, green: 0.14, blue: 0.56), Color(red: 0.10, green: 0.34, blue: 0.88), Color(red: 0.05, green: 0.16, blue: 0.60)],
                startPoint: .topLeading, endPoint: .bottomTrailing
            )
        case 2:
            return LinearGradient(
                colors: [Color(red: 0.06, green: 0.10, blue: 0.38), Color(red: 0.16, green: 0.24, blue: 0.68), Color(red: 0.04, green: 0.08, blue: 0.34)],
                startPoint: .top, endPoint: .bottom
            )
        default:
            return LinearGradient(
                colors: [Color(red: 0.04, green: 0.18, blue: 0.66), Color(red: 0.10, green: 0.40, blue: 0.94), Color(red: 0.05, green: 0.22, blue: 0.76)],
                startPoint: .topLeading, endPoint: .bottomTrailing
            )
        }
    }

    private func triggerMbNotice(_ title: String, _ message: String) {
        fakeMbAlertTitle = title
        fakeMbAlertMessage = message
        showFakeMbAlert = true
    }

    private var mb3DBlocksBackground: some View {
        ZStack {
            mbBackgroundGradient.ignoresSafeArea()

            // Các khối 3D xanh vát nổi giống hệt nền gốc MB Bank (Ảnh 1 & Ảnh 3)
            GeometryReader { geo in
                Group {
                    mb3DPill(width: geo.size.width * 0.92, height: 118)
                        .rotationEffect(.degrees(-19))
                        .position(x: geo.size.width * 0.66, y: geo.size.height * 0.18)

                    mb3DPill(width: geo.size.width * 0.96, height: 114)
                        .rotationEffect(.degrees(5))
                        .position(x: geo.size.width * 0.72, y: geo.size.height * 0.34)

                    mb3DPill(width: geo.size.width * 0.86, height: 120)
                        .rotationEffect(.degrees(44))
                        .position(x: geo.size.width * 0.44, y: geo.size.height * 0.51)

                    mb3DPill(width: geo.size.width * 0.72, height: 108)
                        .rotationEffect(.degrees(-24))
                        .position(x: geo.size.width * 0.08, y: geo.size.height * 0.58)
                }
            }
            .ignoresSafeArea()
        }
    }

    private func mb3DPill(width: CGFloat, height: CGFloat) -> some View {
        ZStack {
            // Đế bóng 3D xanh đậm phía dưới khối
            RoundedRectangle(cornerRadius: height * 0.46)
                .fill(
                    LinearGradient(
                        colors: [Color(red: 0.03, green: 0.14, blue: 0.68), Color(red: 0.02, green: 0.09, blue: 0.48)],
                        startPoint: .leading, endPoint: .trailing
                    )
                )
                .frame(width: width, height: height)
                .offset(y: 16)
                .shadow(color: Color.black.opacity(0.32), radius: 18, x: 0, y: 12)

            // Mặt trên sáng ánh xanh 3D
            RoundedRectangle(cornerRadius: height * 0.46)
                .fill(
                    LinearGradient(
                        colors: [Color(red: 0.42, green: 0.66, blue: 1.0), Color(red: 0.18, green: 0.42, blue: 0.94)],
                        startPoint: .topLeading, endPoint: .bottomTrailing
                    )
                )
                .frame(width: width, height: height)
                .overlay(
                    RoundedRectangle(cornerRadius: height * 0.46)
                        .stroke(Color.white.opacity(0.55), lineWidth: 1.5)
                )
        }
    }

    private var mbBankDisguiseView: some View {
        ZStack {
            mb3DBlocksBackground

            VStack(spacing: 0) {
                // Header trên cùng: Logo sao 10 nét đỏ MB (trái) + Cờ / Chuông / Hỗ trợ (phải)
                HStack(alignment: .top) {
                    HStack(spacing: 6) {
                        MBStarVectorView()
                            .frame(width: 34, height: 34)
                        Text("MB")
                            .font(.system(size: 30, weight: .black, design: .rounded))
                            .foregroundColor(.white)
                    }
                    .padding(.top, 4)

                    Spacer()

                    VStack(alignment: .trailing, spacing: 10) {
                        HStack(spacing: 8) {
                            ZStack {
                                Circle()
                                    .fill(Color(red: 0.85, green: 0.12, blue: 0.18))
                                    .frame(width: 28, height: 28)
                                Image(systemName: "star.fill")
                                    .font(.system(size: 12))
                                    .foregroundColor(.yellow)
                            }

                            Button(action: {
                                triggerMbNotice("Thông báo MB", "Hiện chưa có thông báo mới.")
                            }) {
                                Image(systemName: "bell.fill")
                                    .font(.system(size: 15))
                                    .foregroundColor(.white)
                                    .frame(width: 32, height: 32)
                                    .background(Color.white.opacity(0.18))
                                    .clipShape(Circle())
                            }
                        }

                        Button(action: {
                            triggerMbNotice("Hỗ trợ 24/7", "Tổng đài MB Bank: 1900 5454 26.")
                        }) {
                            VStack(spacing: 2) {
                                Image(systemName: "headphones.circle.fill")
                                    .font(.system(size: 26))
                                    .foregroundColor(.yellow)
                                Text("HỖ TRỢ")
                                    .font(.system(size: 8, weight: .black))
                                    .foregroundColor(.white)
                                    .padding(.horizontal, 5)
                                    .padding(.vertical, 1.5)
                                    .background(Color(red: 0.0, green: 0.72, blue: 0.96))
                                    .cornerRadius(4)
                            }
                        }
                    }
                }
                .padding(.horizontal, 18)
                .padding(.top, 10)

                Spacer()

                // Thẻ kính mờ đăng nhập MB Bank ở giữa
                VStack(alignment: .leading, spacing: 0) {
                    VStack(alignment: .leading, spacing: 14) {
                        Image(systemName: "checkmark.shield.fill")
                            .font(.system(size: 20))
                            .foregroundColor(Color(red: 0.25, green: 0.85, blue: 0.65))

                        VStack(alignment: .leading, spacing: 4) {
                            Text("Xin chào,")
                                .font(.system(size: 15, weight: .medium))
                                .foregroundColor(.white.opacity(0.92))

                            HStack(alignment: .center) {
                                Text(mbDisplayName)
                                    .font(.system(size: 26, weight: .regular))
                                    .foregroundColor(.white)
                                    .lineLimit(2)
                                    .minimumScaleFactor(0.75)

                                Spacer()

                                Button(action: {
                                    triggerMbNotice("Face ID", "Xác thực Face ID không thành công. Vui lòng nhập mật khẩu.")
                                }) {
                                    Image(systemName: "faceid")
                                        .font(.system(size: 22))
                                        .foregroundColor(Color(red: 0.45, green: 0.85, blue: 1.0))
                                        .frame(width: 44, height: 44)
                                        .background(Color.black.opacity(0.20))
                                        .clipShape(Circle())
                                        .overlay(
                                            Circle().stroke(Color.white.opacity(0.18), lineWidth: 1)
                                        )
                                }
                            }
                        }

                        VStack(spacing: 6) {
                            SecureField("Mật khẩu", text: $fakeMbPassword)
                                .foregroundColor(.white)
                                .accentColor(.white)
                                .font(.system(size: 15))
                                .padding(.vertical, 6)

                            Rectangle()
                                .fill(Color.white.opacity(0.45))
                                .frame(height: 1)
                        }

                        HStack {
                            Button(action: {
                                triggerMbNotice("Tài khoản khác", "Vui lòng sử dụng tài khoản chính chủ để đăng nhập.")
                            }) {
                                Text("Tài khoản khác")
                                    .font(.system(size: 13, weight: .semibold))
                                    .foregroundColor(.white)
                            }
                            Spacer()
                            Button(action: {
                                triggerMbNotice("Quên mật khẩu", "Vui lòng liên hệ tổng đài 1900 5454 26 hoặc ra quầy giao dịch MB.")
                            }) {
                                Text("Quên mật khẩu?")
                                    .font(.system(size: 13, weight: .semibold))
                                    .foregroundColor(.white)
                            }
                        }
                        .padding(.top, 4)
                    }
                    .padding(20)
                    .background(Color(red: 0.08, green: 0.22, blue: 0.62).opacity(0.62))

                    Button(action: {
                        if fakeMbPassword.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                            triggerMbNotice("Thông báo", "Vui lòng nhập mật khẩu để đăng nhập.")
                        } else {
                            fakeMbPassword = ""
                            triggerMbNotice("Đăng nhập không thành công", "Mật khẩu không chính xác. Vui lòng kiểm tra và thử lại.")
                        }
                    }) {
                        Text("Đăng nhập")
                            .font(.system(size: 16, weight: .bold))
                            .foregroundColor(Color(red: 0.05, green: 0.14, blue: 0.38))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 16)
                            .background(Color(red: 0.45, green: 0.88, blue: 0.98))
                    }
                }
                .clipShape(RoundedRectangle(cornerRadius: 18))
                .overlay(
                    RoundedRectangle(cornerRadius: 18)
                        .stroke(Color.white.opacity(0.22), lineWidth: 1)
                )
                .shadow(color: Color.black.opacity(0.28), radius: 16, x: 0, y: 8)
                .padding(.horizontal, 22)
                .frame(maxWidth: 440)

                Spacer()

                // Hàng tiện ích dưới cùng: Quét QR | Xác thực D-OTP | Thay ảnh nền
                VStack(spacing: 14) {
                    HStack(spacing: 28) {
                        Button(action: {
                            triggerMbNotice("Quét QR", "Vui lòng đăng nhập để sử dụng tính năng Quét QR.")
                        }) {
                            VStack(spacing: 6) {
                                Image(systemName: "qrcode.viewfinder")
                                    .font(.system(size: 22))
                                Text("Quét QR")
                                    .font(.system(size: 12, weight: .medium))
                            }
                            .foregroundColor(.white)
                        }

                        Button(action: {
                            triggerMbNotice("Xác thực D-OTP", "Chưa có yêu cầu xác thực giao dịch D-OTP.")
                        }) {
                            VStack(spacing: 6) {
                                Image(systemName: "lock.shield")
                                    .font(.system(size: 22))
                                Text("Xác thực D-OTP")
                                    .font(.system(size: 12, weight: .medium))
                            }
                            .foregroundColor(.white)
                        }

                        Button(action: {
                            withAnimation(.easeInOut(duration: 0.25)) {
                                mbBgThemeIndex = (mbBgThemeIndex + 1) % 3
                            }
                        }) {
                            VStack(spacing: 6) {
                                ZStack(alignment: .topTrailing) {
                                    Image(systemName: "photo.on.rectangle.angled")
                                        .font(.system(size: 22))
                                    Text("NEW")
                                        .font(.system(size: 7, weight: .black))
                                        .foregroundColor(.white)
                                        .padding(.horizontal, 4)
                                        .padding(.vertical, 1)
                                        .background(Color.red)
                                        .cornerRadius(4)
                                        .offset(x: 10, y: -6)
                                }
                                Text("Thay ảnh nền")
                                    .font(.system(size: 12, weight: .medium))
                            }
                            .foregroundColor(.white)
                        }
                    }

                    Image(systemName: "chevron.up.2")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundColor(.white.opacity(0.85))
                }
                .padding(.bottom, 16)
            }
        }
    }

    private var realLoginOverlay: some View {
        ZStack {
            Color.black.opacity(0.75)
                .ignoresSafeArea()
                .onTapGesture {
                    withAnimation { showRealLogin = false }
                }

            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    Text("Đăng nhập hệ thống")
                        .font(.headline)
                        .foregroundColor(.white)
                    Spacer()
                    Button(action: {
                        withAnimation { showRealLogin = false }
                    }) {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 22))
                            .foregroundColor(.gray)
                    }
                }

                if let err = networkManager.errorMessage {
                    Text(err)
                        .font(.caption)
                        .foregroundColor(.red)
                        .padding(8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.red.opacity(0.15))
                        .cornerRadius(8)
                }

                TextField("Tên đăng nhập", text: $usernameInput)
                    .textFieldStyle(RoundedBorderTextFieldStyle())
                    .autocapitalization(.none)
                    .disableAutocorrection(true)

                SecureField("Mật khẩu", text: $passwordInput)
                    .textFieldStyle(RoundedBorderTextFieldStyle())

                Text("UUID: \(DeviceBindingManager.shared.getOrCreateDeviceUUID())")
                    .font(.system(size: 9.5, design: .monospaced))
                    .foregroundColor(.yellow)
                    .lineLimit(1)

                Button(action: {
                    networkManager.loginMobile(username: usernameInput, password: passwordInput) { success in
                        if success {
                            showRealLogin = false
                            locationManager.requestPermissions()
                            cameraManager.setupCamera { _ in }
                        }
                    }
                }) {
                    Text("ĐĂNG NHẬP")
                        .font(.headline)
                        .foregroundColor(.white)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                        .background(Color(red: 0.08, green: 0.12, blue: 0.82))
                        .cornerRadius(12)
                }
            }
            .padding(20)
            .background(Color(red: 0.10, green: 0.12, blue: 0.18))
            .cornerRadius(20)
            .overlay(
                RoundedRectangle(cornerRadius: 20)
                    .stroke(Color.white.opacity(0.15), lineWidth: 1)
            )
            .padding(.horizontal, 24)
            .frame(maxWidth: 420)
        }
    }
}

/// Bắt cử chỉ chạm 3 ngón tay 3 lần trên cửa sổ chính mà không cản trở các nút bấm 1 ngón trên giao diện MB Bank
private struct ThreeFingerTripleTapInstaller: UIViewRepresentable {
    var onTrigger: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onTrigger: onTrigger)
    }

    func makeUIView(context: Context) -> UIView {
        let view = UIView(frame: .zero)
        view.backgroundColor = .clear
        view.isUserInteractionEnabled = false
        DispatchQueue.main.async {
            context.coordinator.attachIfNeeded(from: view)
        }
        return view
    }

    func updateUIView(_ uiView: UIView, context: Context) {
        context.coordinator.onTrigger = onTrigger
        DispatchQueue.main.async {
            context.coordinator.attachIfNeeded(from: uiView)
        }
    }

    static func dismantleUIView(_ uiView: UIView, coordinator: Coordinator) {
        coordinator.detach()
    }

    class Coordinator: NSObject {
        var onTrigger: () -> Void
        private weak var attachedWindow: UIWindow?
        private var gesture: UITapGestureRecognizer?

        init(onTrigger: @escaping () -> Void) {
            self.onTrigger = onTrigger
        }

        func attachIfNeeded(from view: UIView) {
            guard let window = view.window else { return }
            if attachedWindow === window, gesture != nil { return }
            detach()
            let tap = UITapGestureRecognizer(target: self, action: #selector(handleTripleThreeFingerTap))
            tap.numberOfTouchesRequired = 3
            tap.numberOfTapsRequired = 3
            tap.cancelsTouchesInView = false
            tap.delaysTouchesBegan = false
            tap.delaysTouchesEnded = false
            window.addGestureRecognizer(tap)
            attachedWindow = window
            gesture = tap
        }

        func detach() {
            if let g = gesture, let w = attachedWindow {
                w.removeGestureRecognizer(g)
            }
            gesture = nil
            attachedWindow = nil
        }

        @objc private func handleTripleThreeFingerTap() {
            DispatchQueue.main.async {
                self.onTrigger()
            }
        }
    }
}


/// Logo ngôi sao 10 nét đứt đỏ chuẩn MB Bank (trích từ tọa độ thật của icon MB)
private struct MBStarVectorView: View {
    private static let segments: [(CGFloat, CGFloat, CGFloat, CGFloat, CGFloat, CGFloat)] = [
        (0.498, 0.253, 0.591, 0.125, 0.036, 0.043),
        (0.152, 0.282, 0.244, 0.410, 0.042, 0.036),
        (0.613, 0.271, 0.614, 0.443, 0.032, 0.044),
        (0.298, 0.306, 0.463, 0.361, 0.033, 0.042),
        (0.725, 0.449, 0.875, 0.494, 0.035, 0.043),
        (0.233, 0.618, 0.337, 0.477, 0.034, 0.042),
        (0.578, 0.615, 0.744, 0.561, 0.042, 0.033),
        (0.407, 0.634, 0.509, 0.776, 0.042, 0.033),
        (0.167, 0.751, 0.315, 0.701, 0.042, 0.036),
        (0.612, 0.878, 0.613, 0.723, 0.041, 0.035),
    ]

    var body: some View {
        Canvas { ctx, size in
            let w = size.width
            let h = size.height
            let red = Color(red: 0.96, green: 0.16, blue: 0.30)
            for seg in Self.segments {
                let x1 = seg.0 * w, y1 = seg.1 * h
                let x2 = seg.2 * w, y2 = seg.3 * h
                let r1 = seg.4 * w, r2 = seg.5 * w
                let dx = x2 - x1, dy = y2 - y1
                let len = max(0.001, hypot(dx, dy))
                let px = -dy / len, py = dx / len

                var poly = Path()
                poly.move(to: CGPoint(x: x1 + px * r1, y: y1 + py * r1))
                poly.addLine(to: CGPoint(x: x2 + px * r2, y: y2 + py * r2))
                poly.addLine(to: CGPoint(x: x2 - px * r2, y: y2 - py * r2))
                poly.addLine(to: CGPoint(x: x1 - px * r1, y: y1 - py * r1))
                poly.closeSubpath()
                ctx.fill(poly, with: .color(red))

                ctx.fill(Path(ellipseIn: CGRect(x: x1 - r1, y: y1 - r1, width: r1 * 2, height: r1 * 2)), with: .color(red))
                ctx.fill(Path(ellipseIn: CGRect(x: x2 - r2, y: y2 - r2, width: r2 * 2, height: r2 * 2)), with: .color(red))
            }
        }
    }
}
