import Foundation

/// NetworkManager trao đổi dữ liệu với Backend Server: Đăng nhập, Khóa Device UUID,
/// Khởi tạo phiên Stream, Gửi định vị GPS. Video truyền qua RTMP/HLS (không qua socket/JSON).
public class NetworkManager: ObservableObject {
    public static let shared = NetworkManager()

    // Cấu hình máy chủ gán cứng cố định (Ẩn hoàn toàn khỏi giao diện người dùng)
    public static let defaultServerURL = "https://streamslo.date"
    public static let defaultRtmpHost = "161.248.146.201"
    public static let defaultRtmpPort = "1935"

    @Published public var serverURL: String = defaultServerURL {
        didSet {
            UserDefaults.standard.set(serverURL, forKey: "saved_server_url")
        }
    }
    @Published public var isAuthenticated = false
    @Published public var authToken: String? = nil
    @Published public var currentUsername: String? = nil
    @Published public var currentUserId: String? = nil
    @Published public var userExpiresAt: String? = nil
    @Published public var activeStreamId: String? = nil
    @Published public var streamKey: String? = nil
    @Published public var rtmpIngestUrl: String? = nil
    @Published public var hlsPlaylistUrl: String? = nil
    @Published public var errorMessage: String? = nil

    /// Host & Port RTMP gán cứng vào VPS 161.248.146.201:1935
    @Published public var customRtmpHost: String = defaultRtmpHost {
        didSet {
            UserDefaults.standard.set(customRtmpHost, forKey: "custom_rtmp_host")
        }
    }
    @Published public var customRtmpPort: String = defaultRtmpPort {
        didSet {
            UserDefaults.standard.set(customRtmpPort, forKey: "custom_rtmp_port")
        }
    }

    private init() {
        let savedUrl = UserDefaults.standard.string(forKey: "saved_server_url")
        if savedUrl == nil || savedUrl?.contains("157.66.100.10") == true || savedUrl?.contains("slomoview.stream") == true {
            self.serverURL = NetworkManager.defaultServerURL
            UserDefaults.standard.set(NetworkManager.defaultServerURL, forKey: "saved_server_url")
        } else {
            self.serverURL = savedUrl ?? NetworkManager.defaultServerURL
        }

        let savedHost = UserDefaults.standard.string(forKey: "custom_rtmp_host")
        if savedHost == nil || savedHost == "157.66.100.10" || savedHost?.contains("slomoview.stream") == true {
            self.customRtmpHost = NetworkManager.defaultRtmpHost
            UserDefaults.standard.set(NetworkManager.defaultRtmpHost, forKey: "custom_rtmp_host")
        } else {
            self.customRtmpHost = savedHost ?? NetworkManager.defaultRtmpHost
        }

        self.customRtmpPort = UserDefaults.standard.string(forKey: "custom_rtmp_port") ?? NetworkManager.defaultRtmpPort

        // Khôi phục phiên đăng nhập đã lưu (ghi nhớ đăng nhập)
        if let token = UserDefaults.standard.string(forKey: "saved_auth_token"), !token.isEmpty {
            self.authToken = token
            self.currentUsername = UserDefaults.standard.string(forKey: "saved_username")
            self.currentUserId = UserDefaults.standard.string(forKey: "saved_user_id")
            self.userExpiresAt = UserDefaults.standard.string(forKey: "saved_user_expires_at")
            self.isAuthenticated = true

            // Tự động làm mới hạn dùng và thông tin tài khoản từ máy chủ
            DispatchQueue.main.async {
                self.fetchUserProfile()
            }
        }
    }

    public static func normalizeServerURL(_ raw: String) -> String {
        var clean = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if clean.isEmpty { return clean }

        if !clean.hasPrefix("http://") && !clean.hasPrefix("https://") {
            if clean.contains("trycloudflare.com") || clean.contains("ngrok") {
                clean = "https://\(clean)"
            } else {
                clean = "http://\(clean)"
            }
        }

        if clean.contains("trycloudflare.com") || clean.contains("ngrok") {
            if clean.hasPrefix("http://") {
                clean = clean.replacingOccurrences(of: "http://", with: "https://")
            }
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

    /// Đăng nhập thiết bị di động với kiểm tra duy nhất 01 deviceUUID
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
            "appType": "APP_LIVE",
            "deviceUuid": deviceUUID,
            "deviceModel": DeviceBindingManager.shared.getDeviceModelName(),
            "deviceFingerprint": DeviceBindingManager.shared.getDeviceFingerprint()
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
                    self.currentUserId = (user["id"] as? String) ?? (user["_id"] as? String)
                    self.userExpiresAt = user["expiresAt"] as? String
                    self.isAuthenticated = true
                    self.errorMessage = nil

                    // Ghi nhớ phiên đăng nhập an toàn
                    UserDefaults.standard.set(token, forKey: "saved_auth_token")
                    UserDefaults.standard.set(self.currentUsername, forKey: "saved_username")
                    UserDefaults.standard.set(self.currentUserId, forKey: "saved_user_id")
                    if let exp = self.userExpiresAt {
                        UserDefaults.standard.set(exp, forKey: "saved_user_expires_at")
                    } else {
                        UserDefaults.standard.removeObject(forKey: "saved_user_expires_at")
                    }

                    completion(true)
                } else {
                    self.errorMessage = "Đăng nhập thất bại."
                    completion(false)
                }
            }
        }.resume()
    }

    /// Đăng xuất tài khoản và xóa phiên đăng nhập đã lưu
    public func logout() {
        self.authToken = nil
        self.currentUsername = nil
        self.currentUserId = nil
        self.userExpiresAt = nil
        self.isAuthenticated = false
        self.activeStreamId = nil
        self.streamKey = nil
        self.rtmpIngestUrl = nil
        self.hlsPlaylistUrl = nil
        UserDefaults.standard.removeObject(forKey: "saved_auth_token")
        UserDefaults.standard.removeObject(forKey: "saved_username")
        UserDefaults.standard.removeObject(forKey: "saved_user_id")
        UserDefaults.standard.removeObject(forKey: "saved_user_expires_at")
    }

    /// Tải lại thông tin User và hạn dùng mới nhất từ máy chủ qua GET /api/auth/me
    public func fetchUserProfile(completion: ((Bool) -> Void)? = nil) {
        guard let token = self.authToken, !token.isEmpty else {
            completion?(false)
            return
        }
        let clean = NetworkManager.normalizeServerURL(serverURL)
        guard let url = URL(string: "\(clean)/api/auth/me") else {
            completion?(false)
            return
        }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 8.0

        URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            guard let self = self, let data = data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let user = json["user"] as? [String: Any] else {
                completion?(false)
                return
            }
            DispatchQueue.main.async {
                if let exp = user["expiresAt"] as? String {
                    self.userExpiresAt = exp
                    UserDefaults.standard.set(exp, forKey: "saved_user_expires_at")
                }
                if let uname = user["username"] as? String {
                    self.currentUsername = uname
                    UserDefaults.standard.set(uname, forKey: "saved_username")
                }
                completion?(true)
            }
        }.resume()
    }

    /// Định dạng thời gian hết hạn thân thiện (Ví dụ: Còn 29 ngày 14 giờ / Vĩnh viễn)
    public func getRemainingTimeText() -> String {
        guard let expStr = userExpiresAt, !expStr.isEmpty else {
            return "Đang tải hạn dùng..."
        }
        if expStr == "LIFETIME" {
            return "Vĩnh viễn (Lifetime)"
        }
        let isoFormatter = ISO8601DateFormatter()
        isoFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let expDate = isoFormatter.date(from: expStr) ?? ISO8601DateFormatter().date(from: expStr) else {
            return "Vĩnh viễn (Lifetime)"
        }
        let diff = expDate.timeIntervalSince(Date())
        if diff <= 0 { return "Đã hết hạn" }
        let days = Int(diff) / 86400
        let hours = (Int(diff) % 86400) / 3600
        let minutes = (Int(diff) % 3600) / 60
        if days > 0 {
            return "Còn \(days) ngày \(hours) giờ"
        } else if hours > 0 {
            return "Còn \(hours) giờ \(minutes) phút"
        } else {
            return "Còn \(minutes) phút"
        }
    }

    /// Gọi `/api/server-info` để biết server đang chạy + auto-fill URL. Gọi NGAY khi app mở
    /// (không cần auth) để kiểm tra server có sống không + lấy IP LAN chính xác.
    /// - Parameters:
    ///   - completion: callback với (Bool, serverInfoJson?)
    public func fetchServerInfo(completion: @escaping (Bool, [String: Any]?) -> Void) {
        let clean = NetworkManager.normalizeServerURL(serverURL)
        guard let url = URL(string: "\(clean)/api/server-info") else {
            completion(false, nil)
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = 5.0
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        URLSession.shared.dataTask(with: request) { data, response, error in
            DispatchQueue.main.async {
                if let error = error {
                    print("[Network] /api/server-info failed: \(error.localizedDescription)")
                    completion(false, nil)
                    return
                }
                guard let data = data, let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                    completion(false, nil)
                    return
                }
                print("[Network] /api/server-info response: \(json.keys)")
                if let server = json["server"] as? [String: Any] {
                    print("[Network]   - connectionType: \(server["connectionType"] ?? "?")")
                    print("[Network]   - recommendedRtmpUrl: \(server["recommendedRtmpUrl"] ?? "?")")
                }
                completion(true, json)
            }
        }.resume()
    }

    /// Bắt đầu phiên Live Stream: server trả streamKey + rtmpIngestUrl. iOS dùng 2 giá trị này
    /// để đẩy RTMP/H.264 vào NMS (xem CameraManager.startLiveStream).
    /// KHÔNG còn WebSocket nhị phân / JPEG / HTTP fallback cho video.
    public func startStream(completion: @escaping (Bool) -> Void) {
        guard let token = authToken, let url = URL(string: "\(apiBaseURL)/stream/start") else {
            completion(false)
            return
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        // Nếu user điền RTMP Host Override (vd: dùng 5G + Pinggy tunnel cho port 1935),
        // gửi kèm header để server ưu tiên trả về host:port này thay vì tự đoán từ Host header
        // của request HTTP (thường sai vì HTTP và RTMP có thể đi qua 2 tunnel khác nhau).
        let trimmedHost = customRtmpHost.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedHost.isEmpty {
            request.setValue(trimmedHost, forHTTPHeaderField: "X-RTMP-Host")
            let trimmedPort = customRtmpPort.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmedPort.isEmpty {
                request.setValue(trimmedPort, forHTTPHeaderField: "X-RTMP-Port")
            }
        }

        URLSession.shared.dataTask(with: request) { data, response, error in
            DispatchQueue.main.async {
                guard let data = data, let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let streamObj = json["stream"] as? [String: Any],
                      let streamId = streamObj["id"] as? String,
                      let streamKey = (streamObj["streamKey"] as? String) ?? (json["streamKey"] as? String) else {
                    completion(false)
                    return
                }
                self.activeStreamId = streamId
                self.streamKey = streamKey
                // Nhận URL ingest từ server. Nếu server không trả (lỗi / dev), giữ nguyên nil — UI
                // sẽ báo lỗi "chưa cấu hình RTMP" thay vì mặc định localhost (gây crash qua 5G).
                self.rtmpIngestUrl = json["rtmpIngestUrl"] as? String
                self.hlsPlaylistUrl = streamObj["hlsPlaylistUrl"] as? String
                completion(true)
            }
        }.resume()
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
        self.streamKey = nil
        self.rtmpIngestUrl = nil
    }
}
