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

    @State private var usernameInput = "demouser"
    @State private var passwordInput = "user123"
    @State private var isFakeLocked = false

    // customRtmpHost / customRtmpPort giờ sống trong networkManager (đã @Published + lưu
    // UserDefaults ở đó) để NetworkManager.startStream() có thể đọc và gửi lên server qua
    // header X-RTMP-Host / X-RTMP-Port. Xem NetworkManager.swift.

    var body: some View {
        ZStack {
            Color.black.edgesIgnoringSafeArea(.all)

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
                                    Text(cameraManager.isStreaming ? "LIVE 240FPS" : "SẴN SÀNG")
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

                        // Controls Bar
                        VStack(spacing: 16) {
                            Button(action: {
                                if cameraManager.isStreaming {
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
                                    Image(systemName: cameraManager.isStreaming ? "stop.fill" : "play.fill")
                                    Text(cameraManager.isStreaming ? "DỪNG PHÁT LIVE" : "BẮT ĐẦU LIVE 240FPS")
                                        .fontWeight(.bold)
                                }
                                .font(.title3)
                                .foregroundColor(.white)
                                .padding(.horizontal, 32)
                                .padding(.vertical, 16)
                                .background(cameraManager.isStreaming ? Color.red : Color.indigo)
                                .cornerRadius(20)
                                .shadow(radius: 10)
                            }

                            // Fake Lock / Stealth Screen Saver Button
                            Button(action: {
                                withAnimation {
                                    isFakeLocked = true
                                    UIScreen.main.brightness = 0.0
                                    UIApplication.shared.isIdleTimerDisabled = true
                                }
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

                    // 100% Pure Pitch Black Screen Overlay (No text, No clock, 100% Stealth)
                    if isFakeLocked {
                        Color.black
                            .edgesIgnoringSafeArea(.all)
                            .contentShape(Rectangle())
                            .onTapGesture(count: 2) {
                                withAnimation {
                                    isFakeLocked = false
                                    UIScreen.main.brightness = 0.6
                                }
                            }
                            .statusBar(hidden: true)
                            .edgesIgnoringSafeArea(.all)
                    }
                }
            }
        }
    }
}
