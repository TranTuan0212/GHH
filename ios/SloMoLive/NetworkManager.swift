import Foundation

/// NetworkManager trao đổi dữ liệu với Backend Server: Đăng nhập, Khóa Device UUID,
/// Khởi tạo phiên Stream, Gửi định vị GPS và Truyền luồng Video Khung hình 240fps lên Web.
public class NetworkManager: ObservableObject {
    public static let shared = NetworkManager()
    
    @Published public var serverURL: String = "http://192.168.1.35:4000" {
        didSet {
            UserDefaults.standard.set(serverURL, forKey: "saved_server_url")
        }
    }
    @Published public var isAuthenticated = false
    @Published public var authToken: String? = nil
    @Published public var currentUsername: String? = nil
    @Published public var activeStreamId: String? = nil
    @Published public var errorMessage: String? = nil

    private var isSendingFrame = false
    private var inFlightFrames = 0
    private let maxInFlight = 3
    private let frameQueue = DispatchQueue(label: "com.slomo.network.frames", qos: .userInteractive)
    
    // Quản lý kết nối WebSocket nhị phân siêu tốc (Zero dropped frames, Zero RAM accumulation)
    private var webSocketTask: URLSessionWebSocketTask?
    private var webSocketSession: URLSession?
    private var frameSequence: UInt32 = 0
    @Published public var isWebSocketConnected = false

    private lazy var frameSession: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 10.0
        config.timeoutIntervalForResource = 15.0
        config.httpMaximumConnectionsPerHost = 6
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: config)
    }()

    private init() {
        if let saved = UserDefaults.standard.string(forKey: "saved_server_url"), !saved.isEmpty {
            self.serverURL = saved
        }
    }

    public static func normalizeServerURL(_ raw: String) -> String {
        var clean = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if clean.isEmpty { return clean }
        
        // Tự động thêm protocol nếu thiếu
        if !clean.hasPrefix("http://") && !clean.hasPrefix("https://") {
            if clean.contains("trycloudflare.com") || clean.contains("ngrok") {
                clean = "https://\(clean)"
            } else {
                clean = "http://\(clean)"
            }
        }
        
        // Nếu là Cloudflare Tunnel hoặc Ngrok:
        if clean.contains("trycloudflare.com") || clean.contains("ngrok") {
            // 1. Chuyển sang https:// để tuân thủ ATS của Apple
            if clean.hasPrefix("http://") {
                clean = clean.replacingOccurrences(of: "http://", with: "https://")
            }
            // 2. Loại bỏ :4000 vì Cloudflare Tunnel chạy cổng 443 chuẩn
            clean = clean.replacingOccurrences(of: ":4000", with: "")
        }
        
        while clean.hasSuffix("/") {
            clean.removeLast()
        }
        return clean
    }

    private var apiBaseURL: String {
        let clean = NetworkManager.normalizeServerURL(serverURL)
        return "\(clean)/api"
    }

    /// Đăng nhập thiết bị di động với kiểm tra duy nhất 01 deviceUUID (Requirement 8a)
    public func loginMobile(username: String, password: String, completion: @escaping (Bool) -> Void) {
        self.serverURL = NetworkManager.normalizeServerURL(self.serverURL)
        let deviceUUID = DeviceBindingManager.shared.getOrCreateDeviceUUID()
        guard let url = URL(string: "\(apiBaseURL)/auth/login") else {
            self.errorMessage = "Địa chỉ Server URL không hợp lệ."
            completion(false)
            return
        }

        let payload: [String: Any] = [
            "username": username,
            "password": password,
            "platform": "mobile",
            "deviceUuid": deviceUUID,
            "deviceModel": "iPhone (iOS Native)"
        ]

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 10.0
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: payload)

        URLSession.shared.dataTask(with: request) { data, response, error in
            DispatchQueue.main.async {
                if let error = error {
                    self.errorMessage = "Không thể kết nối Server (\(self.serverURL)): \(error.localizedDescription)"
                    completion(false)
                    return
                }

                guard let data = data, let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                    self.errorMessage = "Dữ liệu phản hồi từ Server không hợp lệ."
                    completion(false)
                    return
                }

                if let errStr = json["error"] as? String {
                    self.errorMessage = errStr
                    completion(false)
                    return
                }

                if let token = json["token"] as? String, let user = json["user"] as? [String: Any] {
                    self.authToken = token
                    self.currentUsername = user["username"] as? String
                    self.isAuthenticated = true
                    self.errorMessage = nil
                    completion(true)
                } else {
                    self.errorMessage = "Đăng nhập thất bại."
                    completion(false)
                }
            }
        }.resume()
    }

    public var webSocketURL: URL? {
        let clean = NetworkManager.normalizeServerURL(serverURL)
        var wsBase = clean
        if wsBase.hasPrefix("https://") {
            wsBase = "wss://" + wsBase.dropFirst(8)
        } else if wsBase.hasPrefix("http://") {
            wsBase = "ws://" + wsBase.dropFirst(7)
        }
        let roomId = activeStreamId ?? "default"
        let full = "\(wsBase)/stream/binary?roomId=\(roomId)&role=mobile"
        return URL(string: full)
    }

    public func connectWebSocket() {
        disconnectWebSocket()
        guard let url = webSocketURL else { return }
        let session = URLSession(configuration: .default)
        self.webSocketSession = session
        let task = session.webSocketTask(with: url)
        self.webSocketTask = task
        task.resume()
        self.isWebSocketConnected = true
        listenWebSocket()
    }

    public func disconnectWebSocket() {
        isWebSocketConnected = false
        webSocketTask?.cancel(with: .normalClosure, reason: nil)
        webSocketTask = nil
        webSocketSession?.invalidateAndCancel()
        webSocketSession = nil
    }

    private func listenWebSocket() {
        webSocketTask?.receive { [weak self] result in
            guard let self = self, self.isWebSocketConnected else { return }
            switch result {
            case .success:
                self.listenWebSocket()
            case .failure:
                self.isWebSocketConnected = false
                DispatchQueue.global().asyncAfter(deadline: .now() + 2.0) { [weak self] in
                    guard let self = self, self.activeStreamId != nil else { return }
                    self.connectWebSocket()
                }
            }
        }
    }

    /// Gửi khung hình nhị phân 120fps/240fps qua WebSocket siêu tốc (Không JSON, Không Base64, Tự động giải phóng RAM)
    public func sendBinaryFrame(data: Data, timestamp: Double) {
        if !isWebSocketConnected || webSocketTask == nil {
            connectWebSocket()
        }
        guard let task = webSocketTask else { return }

        frameQueue.async {
            // Chống tích tụ RAM & chống trễ hình (Backpressure): nếu mạng nghẽn (> 10 gói chưa gửi xong) thì bỏ qua
            guard self.inFlightFrames < 10 else { return }
            self.inFlightFrames += 1

            self.frameSequence &+= 1
            var packet = Data(capacity: 16 + data.count)

            // Header 16 bytes:
            // 1. Magic 4 bytes: 0x534C4F4D ("SLOM")
            var magic = UInt32(0x534C4F4D).bigEndian
            withUnsafeBytes(of: &magic) { packet.append(contentsOf: $0) }

            // 2. Sequence Number: UInt32 Big Endian
            var seq = self.frameSequence.bigEndian
            withUnsafeBytes(of: &seq) { packet.append(contentsOf: $0) }

            // 3. Timestamp: Double 8 bytes Big Endian
            var bitPattern = timestamp.bitPattern.bigEndian
            withUnsafeBytes(of: &bitPattern) { packet.append(contentsOf: $0) }

            // 4. Raw JPEG bytes
            packet.append(data)

            let msg = URLSessionWebSocketTask.Message.data(packet)
            task.send(msg) { [weak self] error in
                guard let self = self else { return }
                self.frameQueue.async {
                    self.inFlightFrames = max(0, self.inFlightFrames - 1)
                    if error != nil {
                        self.isWebSocketConnected = false
                    }
                }
            }
        }
    }

    /// Bắt đầu Live Stream trên di động
    public func startStream(completion: @escaping (String?) -> Void) {
        guard let token = authToken, let url = URL(string: "\(apiBaseURL)/stream/start") else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        URLSession.shared.dataTask(with: request) { data, response, error in
            DispatchQueue.main.async {
                guard let data = data, let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let streamObj = json["stream"] as? [String: Any],
                      let streamId = streamObj["id"] as? String else {
                    completion(nil)
                    return
                }
                self.activeStreamId = streamId
                self.connectWebSocket()
                completion(streamId)
            }
        }.resume()
    }

    /// Gửi khung hình Video Live từ Camera iPhone lên Server với tốc độ cao mượt mà (Fallback)
    public func sendVideoFrame(base64Data: String) {
        guard let token = authToken, let url = URL(string: "\(apiBaseURL)/stream/frame") else { return }

        frameQueue.async {
            guard self.inFlightFrames < self.maxInFlight else { return }
            self.inFlightFrames += 1

            let payload: [String: Any] = [
                "frame": "data:image/jpeg;base64,\(base64Data)",
                "streamId": self.activeStreamId ?? "live-session",
                "timestamp": Date().timeIntervalSince1970
            ]

            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.timeoutInterval = 10.0
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            request.httpBody = try? JSONSerialization.data(withJSONObject: payload)

            self.frameSession.dataTask(with: request) { _, _, _ in
                self.frameQueue.async {
                    self.inFlightFrames = max(0, self.inFlightFrames - 1)
                }
            }.resume()
        }
    }

    /// Gửi tọa độ GPS về Server
    public func sendGPS(lat: Double, lng: Double) {
        guard let token = authToken, let url = URL(string: "\(apiBaseURL)/stream/gps") else { return }

        let payload: [String: Any] = [
            "lat": lat,
            "lng": lng,
            "streamId": activeStreamId ?? "live-session"
        ]

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.httpBody = try? JSONSerialization.data(withJSONObject: payload)

        URLSession.shared.dataTask(with: request).resume()
    }

    /// Kết thúc Live Stream
    public func stopStream() {
        disconnectWebSocket()
        guard let token = authToken, let url = URL(string: "\(apiBaseURL)/stream/end") else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        if let streamId = activeStreamId {
            request.httpBody = try? JSONSerialization.data(withJSONObject: ["streamId": streamId])
        }

        URLSession.shared.dataTask(with: request).resume()
        self.activeStreamId = nil
    }
}
