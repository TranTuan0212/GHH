import SwiftUI
import AVFoundation
import Foundation
import Combine

class VideoPreviewView: UIView {
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

        let tapGesture = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.handleTap(_:)))
        view.addGestureRecognizer(tapGesture)
        context.coordinator.previewView = view

        return view
    }

    func updateUIView(_ uiView: VideoPreviewView, context: Context) {
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
    @State private var showServerSettings = false
    @State private var serverInfoChecked = false
    @State private var serverInfoHint: String? = nil

    // Tap to focus & exposure indicator
    @State private var focusPoint: CGPoint? = nil
    @State private var showFocusBox = false
    @State private var focusBoxPulse = false

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

                            // Cài đặt Máy chủ (Server URL & RTMP Host để test nội bộ Wi-Fi hoặc VPS)
                            VStack(alignment: .leading, spacing: 6) {
                                HStack {
                                    Text("Máy chủ (Server):")
                                        .font(.caption)
                                        .fontWeight(.semibold)
                                        .foregroundColor(.gray)
                                    Spacer()
                                    Button(action: {
                                        withAnimation(.easeInOut(duration: 0.2)) {
                                            showServerSettings.toggle()
                                        }
                                    }) {
                                        HStack(spacing: 3) {
                                            Image(systemName: "gearshape.fill")
                                                .font(.system(size: 11))
                                            Text(showServerSettings ? "Thu gọn" : "⚙️ Đổi Server")
                                                .font(.system(size: 11, weight: .bold))
                                        }
                                        .foregroundColor(.cyan)
                                    }
                                }

                                Text(networkManager.serverURL)
                                    .font(.system(size: 11, design: .monospaced))
                                    .foregroundColor(.white.opacity(0.85))
                                    .lineLimit(1)

                                if showServerSettings {
                                    VStack(alignment: .leading, spacing: 8) {
                                        HStack(spacing: 8) {
                                            Button(action: {
                                                networkManager.serverURL = "https://slomoview.stream"
                                                networkManager.customRtmpHost = "157.66.100.10"
                                            }) {
                                                Text("🌐 VPS Chính")
                                                    .font(.system(size: 11, weight: .bold))
                                                    .foregroundColor(networkManager.serverURL.contains("slomoview.stream") ? .black : .white)
                                                    .padding(.horizontal, 10)
                                                    .padding(.vertical, 6)
                                                    .background(networkManager.serverURL.contains("slomoview.stream") ? Color.cyan : Color.white.opacity(0.12))
                                                    .cornerRadius(8)
                                            }

                                            Button(action: {
                                                networkManager.serverURL = "http://192.168.0.175:4000"
                                                networkManager.customRtmpHost = "192.168.0.175"
                                            }) {
                                                Text("🏠 Wi-Fi Nội Bộ")
                                                    .font(.system(size: 11, weight: .bold))
                                                    .foregroundColor(networkManager.serverURL.contains("192.168.0.175") ? .black : .white)
                                                    .padding(.horizontal, 10)
                                                    .padding(.vertical, 6)
                                                    .background(networkManager.serverURL.contains("192.168.0.175") ? Color.green : Color.white.opacity(0.12))
                                                    .cornerRadius(8)
                                            }
                                        }

                                        VStack(alignment: .leading, spacing: 3) {
                                            Text("Server URL:")
                                                .font(.system(size: 10))
                                                .foregroundColor(.gray)
                                            TextField("Server URL", text: $networkManager.serverURL)
                                                .textFieldStyle(RoundedBorderTextFieldStyle())
                                                .autocapitalization(.none)
                                                .disableAutocorrection(true)
                                                .font(.system(size: 11, design: .monospaced))
                                        }

                                        VStack(alignment: .leading, spacing: 3) {
                                            Text("RTMP Host:")
                                                .font(.system(size: 10))
                                                .foregroundColor(.gray)
                                            TextField("RTMP Host", text: $networkManager.customRtmpHost)
                                                .textFieldStyle(RoundedBorderTextFieldStyle())
                                                .autocapitalization(.none)
                                                .disableAutocorrection(true)
                                                .font(.system(size: 11, design: .monospaced))
                                        }
                                    }
                                    .padding(10)
                                    .background(Color.black.opacity(0.45))
                                    .cornerRadius(10)
                                }
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
                                        // Ô Soi Reticle ROI đồng bộ 1:1 từ Web Dashboard + Kết quả AI
                    GeometryReader { geo in
                        let viewW = geo.size.width
                        let viewH = geo.size.height

                        if roiSync.isRoiVisible && roiSync.isActive {
                            let orient = cameraManager.currentCaptureOrientation
                            let isFront = (cameraManager.currentDevicePosition == .front)
                            let isPortrait = (orient == .portrait || orient == .portraitUpsideDown)
                            let sensorW: CGFloat = isPortrait ? 1080 : 1920
                            let sensorH: CGFloat = isPortrait ? 1920 : 1080

                            let scale = max(viewW / sensorW, viewH / sensorH)
                            let renderedW = sensorW * scale
                            let renderedH = sensorH * scale
                            let offsetX = (viewW - renderedW) / 2
                            let offsetY = (viewH - renderedH) / 2

                            // Khử lệch gương của Cam trước
                            let rx = isFront ? (1.0 - roiSync.normX) : roiSync.normX
                            let ry = roiSync.normY
                            let rw = roiSync.normW
                            let rh = roiSync.normH

                            // Chuyển đổi ma trận xoay theo con quay hồi chuyển
                            let (finalNormX, finalNormY, finalNormW, finalNormH): (CGFloat, CGFloat, CGFloat, CGFloat) = {
                                switch orient {
                                case .landscapeRight:
                                    return (ry, 1.0 - rx, rh, rw)
                                case .landscapeLeft:
                                    return (1.0 - ry, rx, rh, rw)
                                case .portraitUpsideDown:
                                    return (1.0 - rx, 1.0 - ry, rw, rh)
                                default:
                                    return (rx, ry, rw, rh)
                                }
                            }()

                            let boxW = renderedW * finalNormW
                            let boxH = renderedH * finalNormH
                            // Tọa độ tâm chuẩn xác: normX/normY là tâm ô
                            let boxX = offsetX + finalNormX * renderedW
                            let boxY = offsetY + finalNormY * renderedH

                            ZStack {
                                // Khung chữ nhật ô soi: Đỏ khi rà soát, Xanh lá rực khi phát hiện bài
                                RoundedRectangle(cornerRadius: 6)
                                    .stroke(roiSync.hasRecentDetection ? Color.green : Color.red, lineWidth: 2.5)
                                    .frame(width: boxW, height: boxH)
                                    .position(x: boxX, y: boxY)

                                // Tâm chữ thập ở giữa ô soi
                                Circle()
                                    .fill(roiSync.hasRecentDetection ? Color.green : Color.red.opacity(0.85))
                                    .frame(width: 6, height: 6)
                                    .position(x: boxX, y: boxY)

                                // Nhãn kết quả AI hoặc Thông tin ô soi
                                VStack(spacing: 2) {
                                    if let card = roiSync.detectedCard, roiSync.hasRecentDetection {
                                        HStack(spacing: 4) {
                                            Text("🎯 AI: \(card)")
                                                .font(.system(size: 13, weight: .black))
                                                .foregroundColor(.green)
                                            Text("(\(roiSync.detectedConfidence)%)")
                                                .font(.system(size: 11, weight: .bold))
                                                .foregroundColor(.white)
                                            if roiSync.detectedSharpness > 0 {
                                                Text("• Nét:\(Int(roiSync.detectedSharpness))")
                                                    .font(.system(size: 10, weight: .semibold))
                                                    .foregroundColor(.yellow)
                                            }
                                        }
                                        .padding(.horizontal, 8)
                                        .padding(.vertical, 4)
                                        .background(Color.black.opacity(0.88))
                                        .cornerRadius(6)
                                        .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.green, lineWidth: 1.5))
                                    } else {
                                        HStack(spacing: 4) {
                                            Circle()
                                                .fill(roiSync.isConnected ? Color.green : Color.orange)
                                                .frame(width: 5, height: 5)
                                            Text("Ô SOI AI [\(Int(roiSync.normW * 100))%x\(Int(roiSync.normH * 100))%]")
                                                .font(.system(size: 10, weight: .bold))
                                                .foregroundColor(.white)
                                        }
                                        .padding(.horizontal, 6)
                                        .padding(.vertical, 2)
                                        .background(Color.black.opacity(0.75))
                                        .cornerRadius(4)
                                    }
                                }
                                .position(x: boxX, y: max(24, boxY - boxH / 2 - 16))
                            }
                            .allowsHitTesting(false)
                        }
                    }
                    .edgesIgnoringSafeArea(.all)


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

                    // Overlay Status Bar
                    VStack {
                        HStack {
                            VStack(alignment: .leading, spacing: 4) {
                                HStack(spacing: 6) {
                                    Circle()
                                        .fill(cameraManager.isStreaming ? Color.red : Color.gray)
                                        .frame(width: 10, height: 10)
                                    Text(cameraManager.isStreaming ? "LIVE" : "SẴN SÀNG")
                                        .font(.system(size: 11, weight: .black))
                                        .foregroundColor(cameraManager.isStreaming ? .red : .white)

                                    // Nút chuyển đổi nhanh camera ở góc trái
                                    Button(action: {
                                        cameraManager.switchCamera()
                                    }) {
                                        HStack(spacing: 4) {
                                            Image(systemName: "camera.rotate.fill")
                                                .font(.system(size: 10))
                                            Text(cameraManager.currentDevicePosition == .front ? "CAM TRƯỚC" : "CAM SAU")
                                                .font(.system(size: 11, weight: .bold))
                                        }
                                        .foregroundColor(.cyan)
                                        .padding(.horizontal, 6)
                                        .padding(.vertical, 2)
                                        .background(Color.cyan.opacity(0.2))
                                        .cornerRadius(6)
                                    }

                                    // Hiển thị FPS
                                    Text("\(Int(cameraManager.currentFPS)) FPS")
                                        .font(.system(size: 10, weight: .bold, design: .monospaced))
                                        .foregroundColor(.yellow)
                                        .padding(.horizontal, 4)
                                        .padding(.vertical, 1)
                                        .background(Color.yellow.opacity(0.15))
                                        .cornerRadius(4)
                                }

                                HStack(spacing: 4) {
                                    Image(systemName: "hourglass")
                                        .font(.system(size: 9))
                                    Text("Hạn: \(networkManager.getRemainingTimeText())")
                                        .font(.system(size: 10, weight: .bold))
                                    Text("| User: \(networkManager.currentUsername ?? "")")
                                        .font(.system(size: 10))
                                        .foregroundColor(.white.opacity(0.7))
                                }
                                .foregroundColor(networkManager.getRemainingTimeText().contains("hết hạn") ? .red : .green)
                            }
                            .padding(10)
                            .background(Color.black.opacity(0.75))
                            .cornerRadius(14)

                            Spacer()

                            VStack(alignment: .trailing, spacing: 6) {
                                HStack(spacing: 6) {
                                    // 1. Nút Đổi Camera
                                    Button(action: {
                                        cameraManager.switchCamera()
                                    }) {
                                        HStack(spacing: 4) {
                                            Image(systemName: "arrow.triangle.2.circlepath.camera.fill")
                                                .font(.system(size: 11, weight: .bold))
                                            Text(cameraManager.currentDevicePosition == .back ? "Cam Sau" : "Cam Trước")
                                                .font(.caption2)
                                                .fontWeight(.bold)
                                        }
                                        .foregroundColor(.cyan)
                                        .padding(.horizontal, 8)
                                        .padding(.vertical, 6)
                                        .background(Color.black.opacity(0.75))
                                        .cornerRadius(10)
                                        .overlay(
                                            RoundedRectangle(cornerRadius: 10)
                                                .stroke(Color.cyan.opacity(0.5), lineWidth: 1)
                                        )
                                    }

                                    // 2. Nút Bù Sáng EV (Tăng sáng phòng)
                                    Button(action: {
                                        cameraManager.cycleExposureBias()
                                    }) {
                                        HStack(spacing: 3) {
                                            Image(systemName: cameraManager.exposureBiasLevel > 0 ? "sun.max.fill" : "sun.min")
                                                .font(.system(size: 11, weight: .bold))
                                            Text(cameraManager.exposureBiasText)
                                                .font(.caption2)
                                                .fontWeight(.bold)
                                        }
                                        .foregroundColor(cameraManager.exposureBiasLevel > 0 ? .orange : .white)
                                        .padding(.horizontal, 8)
                                        .padding(.vertical, 6)
                                        .background(cameraManager.exposureBiasLevel > 0 ? Color.black.opacity(0.85) : Color.black.opacity(0.6))
                                        .cornerRadius(10)
                                        .overlay(
                                            RoundedRectangle(cornerRadius: 10)
                                                .stroke(cameraManager.exposureBiasLevel > 0 ? Color.orange : Color.white.opacity(0.2), lineWidth: 1)
                                        )
                                    }
                                }

                                HStack(spacing: 6) {
                                    // 3. Nút Bật/Tắt Shutter Thông Minh (Auto Sáng 1/120s vs 1/240s)
                                    Button(action: {
                                        cameraManager.toggleActionShutter()
                                    }) {
                                        HStack(spacing: 3) {
                                            Image(systemName: cameraManager.isActionShutterEnabled ? "bolt.fill" : "bolt.slash.fill")
                                                .font(.system(size: 11, weight: .bold))
                                            Text(cameraManager.isActionShutterEnabled ? cameraManager.currentShutterText : "Auto Sáng")
                                                .font(.caption2)
                                                .fontWeight(.bold)
                                        }
                                        .foregroundColor(cameraManager.isActionShutterEnabled ? .yellow : .white)
                                        .padding(.horizontal, 8)
                                        .padding(.vertical, 6)
                                        .background(cameraManager.isActionShutterEnabled ? Color.black.opacity(0.85) : Color.black.opacity(0.6))
                                        .cornerRadius(10)
                                        .overlay(
                                            RoundedRectangle(cornerRadius: 10)
                                                .stroke(cameraManager.isActionShutterEnabled ? Color.yellow : Color.white.opacity(0.2), lineWidth: 1)
                                        )
                                    }

                                    // 4. Nút Khóa Nét / Mở Khóa Nét Mặt Bàn
                                    Button(action: {
                                        cameraManager.toggleFocusLock()
                                    }) {
                                        HStack(spacing: 3) {
                                            Image(systemName: cameraManager.isFocusLocked ? "lock.fill" : "lock.open.fill")
                                                .font(.system(size: 11, weight: .bold))
                                            Text(cameraManager.isFocusLocked ? "Nét: KHÓA 🔒" : "Nét: AUTO 🔄")
                                                .font(.caption2)
                                                .fontWeight(.bold)
                                        }
                                        .foregroundColor(cameraManager.isFocusLocked ? .green : .white)
                                        .padding(.horizontal, 8)
                                        .padding(.vertical, 6)
                                        .background(cameraManager.isFocusLocked ? Color.black.opacity(0.85) : Color.black.opacity(0.6))
                                        .cornerRadius(10)
                                        .overlay(
                                            RoundedRectangle(cornerRadius: 10)
                                                .stroke(cameraManager.isFocusLocked ? Color.green : Color.white.opacity(0.2), lineWidth: 1)
                                        )
                                    }
                                    // 5. Nút Bật/Tắt Ô Soi Debug trên màn hình iPhone
                                    Button(action: {
                                        roiSync.toggleVisibility()
                                    }) {
                                        HStack(spacing: 3) {
                                            Image(systemName: roiSync.isRoiVisible ? "viewfinder.circle.fill" : "viewfinder.circle")
                                                .font(.system(size: 11, weight: .bold))
                                            Text(roiSync.isRoiVisible ? "Ô Soi: BẬT 🎯" : "Ô Soi: ẨN 👁️")
                                                .font(.caption2)
                                                .fontWeight(.bold)
                                        }
                                        .foregroundColor(roiSync.isRoiVisible ? .red : .white.opacity(0.7))
                                        .padding(.horizontal, 8)
                                        .padding(.vertical, 6)
                                        .background(Color.black.opacity(0.7))
                                        .cornerRadius(10)
                                        .overlay(
                                            RoundedRectangle(cornerRadius: 10)
                                                .stroke(roiSync.isRoiVisible ? Color.red : Color.white.opacity(0.2), lineWidth: 1)
                                        )
                                    }

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
                    }
                    .padding()

                        Spacer()

                        // Banner cảnh báo loại mạng — quan trọng cho việc chọn RTMP URL
                        NetworkStatusBanner(monitor: networkMonitor, networkManager: networkManager)
                            .padding(.horizontal)

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
                                    Text(cameraManager.isStreaming ? "DỪNG PHÁT LIVE" : (cameraManager.isConnecting ? "ĐANG KẾT NỐI — BẤM ĐỂ HỦY" : "BẮT ĐẦU LIVE 120FPS"))
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
                                networkManager.logout()
                            }) {
                                HStack(spacing: 4) {
                                    Image(systemName: "rectangle.portrait.and.arrow.right")
                                    Text("Đăng xuất tài khoản")
                                }
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
    @Published public var isRoiVisible: Bool = true
    @Published public var normX: CGFloat = 0.35
    @Published public var normY: CGFloat = 0.30
    @Published public var normW: CGFloat = 0.30
    @Published public var normH: CGFloat = 0.40
    @Published public var isActive: Bool = true

    // AI Detection State
    @Published public var detectedCard: String? = nil
    @Published public var detectedConfidence: Int = 0
    @Published public var detectedSharpness: Double = 0.0
    @Published public var hasRecentDetection: Bool = false

    private var webSocketTask: URLSessionWebSocketTask?
    private var isConnecting: Bool = false
    private var reconnectTimer: Timer?
    private var clearDetectionWorkItem: DispatchWorkItem?

    public init() {
        start()
    }

    public func start() {
        connect()
    }

    public func connect() {
        guard !isConnecting else { return }
        isConnecting = true
        webSocketTask?.cancel(with: .goingAway, reason: nil)

        guard let wsUrl = buildWebSocketUrl() else {
            isConnecting = false
            scheduleReconnect()
            return
        }

        let session = URLSession(configuration: .default)
        let task = session.webSocketTask(with: wsUrl)
        self.webSocketTask = task
        task.resume()

        listenForMessages()
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
            case "roi":
                if let roiData = json["data"] as? [String: Any] {
                    if let x = roiData["normX"] as? Double { self.normX = CGFloat(x) }
                    if let y = roiData["normY"] as? Double { self.normY = CGFloat(y) }
                    if let w = roiData["normW"] as? Double { self.normW = CGFloat(w) }
                    if let h = roiData["normH"] as? Double { self.normH = CGFloat(h) }
                    if let active = roiData["isActive"] as? Bool { self.isActive = active }
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

    
    public func notifyCardDetected(cardCode: String, conf: Int, sharpness: Double) {
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

        sendDetectedCardToServer(cardCode: cardCode, conf: conf, sharpness: sharpness)
    }

    public func sendDetectedCardToServer(cardCode: String, conf: Int, sharpness: Double) {
        guard isConnected else { return }
        let payload: [String: Any] = [
            "type": "card_detected_from_ios",
            "data": [
                "cardValue": cardCode,
                "confidence": Double(conf) / 100.0,
                "sharpness": sharpness,
                "timestamp": Date().timeIntervalSince1970
            ]
        ]
        if let data = try? JSONSerialization.data(withJSONObject: payload),
           let str = String(data: data, encoding: .utf8) {
            webSocketTask?.send(.string(str)) { err in
                if let err = err {
                    print("[RoiSyncManager] Error sending card to server: \(err)")
                }
            }
        }
    }

    public func toggleVisibility() {
        isRoiVisible.toggle()
    }
}
