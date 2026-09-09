import Foundation

/// NetworkManager trao đổi dữ liệu với Backend Server: Đăng nhập, Khóa Device UUID,
/// Khởi tạo phiên Stream, Gửi định vị GPS. Video truyền qua RTMP/HLS (không qua socket/JSON).
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
    @Published public var streamKey: String? = nil
    @Published public var rtmpIngestUrl: String? = nil
    @Published public var hlsPlaylistUrl: String? = nil
    @Published public var errorMessage: String? = nil

    private init() {
        if let saved = UserDefaults.standard.string(forKey: "saved_server_url"), !saved.isEmpty {
            self.serverURL = saved
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
                self.rtmpIngestUrl = (json["rtmpIngestUrl"] as? String) ?? "rtmp://localhost:1935/live"
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
