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
    @Published public var currentUserId: String? = nil
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

    // MARK: - Hàng đợi khung hình
    // FIFO không có policy tự ý bỏ frame theo latency. Nếu transport chậm, queue tăng
    // để giữ nguyên sequence thay vì âm thầm làm mất frame.
    private struct PendingFrame {
        let seq: UInt32
        let timestamp: Double
        let data: Data
    }
    private var pendingFrames: [PendingFrame] = []
    private var pendingHead = 0
    // Pipelined sender: gửi nhiều frames song song để giảm latency
    // 240fps = frame mỗi 4ms, nhưng WS send qua tunnel mất ~30-50ms
    // => Cần gửi 8-12 frames song song để đạt near-realtime
    private let maxConcurrentSends = 10
    private var activeSendCount = 0

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
                    // Server luôn dùng userId (req.user.id) làm roomId cho stream session,
                    // frame HTTP fallback, gps, card entries... nên phải lưu và dùng đúng giá trị này,
                    // KHÔNG dùng username, để tránh lệch phòng với các kênh còn lại.
                    self.currentUserId = (user["id"] as? String) ?? (user["_id"] as? String)
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

    private var isWebSocketConnecting = false

    public var webSocketURL: URL? {
        let clean = NetworkManager.normalizeServerURL(serverURL)
        var wsBase = clean
        if wsBase.hasPrefix("https://") {
            wsBase = "wss://" + wsBase.dropFirst(8)
        } else if wsBase.hasPrefix("http://") {
            wsBase = "ws://" + wsBase.dropFirst(7)
        }
        // QUAN TRỌNG: phải dùng currentUserId (khớp với req.user.id mà server dùng cho
        // /api/stream/start, /api/stream/frame, gps, card entries...), KHÔNG dùng currentUsername.
        // Nếu dùng username, mobile sẽ gửi frame vào một "room" khác với room mà Web đang join,
        // khiến trạng thái Live lên nhưng hình ảnh không bao giờ tới Web.
        let roomId = currentUserId ?? activeStreamId ?? "default"
        let full = "\(wsBase)/stream/binary?roomId=\(roomId)&role=mobile"
        return URL(string: full)
    }

    public func connectWebSocket() {
        guard !isWebSocketConnected && !isWebSocketConnecting else { return }
        guard let url = webSocketURL else { return }
        
        isWebSocketConnecting = true
        let session = URLSession(configuration: .default)
        self.webSocketSession = session
        let task = session.webSocketTask(with: url)
        self.webSocketTask = task
        task.resume()

        // Xác nhận handshake thành công qua ping trước khi chuyển state sang connected
        task.sendPing { [weak self] error in
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.isWebSocketConnecting = false
                if error == nil {
                    self.isWebSocketConnected = true
                    // Bắt đầu xả các frame đã tích luỹ trong lúc chờ kết nối
                    self.frameQueue.async { self.drainQueueIfNeeded() }
                } else {
                    self.isWebSocketConnected = false
                }
            }
        }
        listenWebSocket()
    }

    public func disconnectWebSocket() {
        isWebSocketConnected = false
        isWebSocketConnecting = false
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
                self.isWebSocketConnecting = false
                DispatchQueue.global().asyncAfter(deadline: .now() + 2.0) { [weak self] in
                    guard let self = self, self.activeStreamId != nil else { return }
                    self.connectWebSocket()
                }
            }
        }
    }

    /// Gửi từng frame 120/240fps theo đúng thứ tự. Không có policy tự ý bỏ frame theo latency.
    /// Nếu mạng chậm hơn nguồn, queue sẽ tăng để tạo back-pressure ở tầng transport thay vì
    /// âm thầm làm mất sequence.
    public func sendBinaryFrame(data: Data, timestamp: Double) {
        frameQueue.async {
            self.frameSequence &+= 1
            self.pendingFrames.append(PendingFrame(seq: self.frameSequence, timestamp: timestamp, data: data))
            self.drainQueueIfNeeded()
        }
    }

    private func pendingFrameCount() -> Int {
        max(0, pendingFrames.count - pendingHead)
    }

    private func compactPendingFramesIfNeeded() {
        if pendingHead >= 1024 && pendingHead * 2 >= pendingFrames.count {
            pendingFrames.removeFirst(pendingHead)
            pendingHead = 0
        }
    }

    private func resetFramePipeline() {
        frameQueue.sync {
            pendingFrames.removeAll(keepingCapacity: true)
            pendingHead = 0
            frameSequence = 0
        }
    }

    /// Gửi pipelined: cho phép gửi nhiều frames song song (maxConcurrentSends) để giảm latency.
    /// Mỗi frame gửi xong sẽ trigger gửi frame tiếp theo.
    private func drainQueueIfNeeded() {
        guard activeSendCount < maxConcurrentSends else { return }
        guard pendingFrameCount() > 0 else { return }

        guard isWebSocketConnected, let task = webSocketTask else {
            connectWebSocket()
            return
        }

        activeSendCount += 1
        let frame = pendingFrames[pendingHead]
        pendingHead += 1
        compactPendingFramesIfNeeded()

        var packet = Data(capacity: 16 + frame.data.count)
        // Header 16 bytes: Magic 4 bytes "SLOM" + Sequence 4 bytes + Timestamp 8 bytes
        var magic = UInt32(0x534C4F4D).bigEndian
        withUnsafeBytes(of: &magic) { packet.append(contentsOf: $0) }
        var seq = frame.seq.bigEndian
        withUnsafeBytes(of: &seq) { packet.append(contentsOf: $0) }
        var bitPattern = frame.timestamp.bitPattern.bigEndian
        withUnsafeBytes(of: &bitPattern) { packet.append(contentsOf: $0) }
        packet.append(frame.data)

        let msg = URLSessionWebSocketTask.Message.data(packet)
        task.send(msg) { [weak self] error in
            guard let self = self else { return }
            self.frameQueue.async {
                self.activeSendCount -= 1
                if error != nil {
                    self.isWebSocketConnected = false
                    // Gửi lỗi: đưa frame trở lại đầu queue để thử lại, không mất sequence.
                    self.pendingHead = max(0, self.pendingHead - 1)
                    if self.pendingHead < self.pendingFrames.count {
                        self.pendingFrames[self.pendingHead] = frame
                    } else {
                        self.pendingFrames.append(frame)
                    }
                }
                // Tiếp tục gửi frames khác (pipelining)
                self.drainQueueIfNeeded()
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
                self.resetFramePipeline()
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
