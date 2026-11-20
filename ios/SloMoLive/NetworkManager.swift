import Foundation
import Network

/// NetworkManager trao đổi dữ liệu với Backend Server: Đăng nhập, Khóa Device UUID,
/// Khởi tạo phiên Stream, Gửi định vị GPS. Video truyền qua RTMP/HLS (không qua socket/JSON).
public class NetworkManager: ObservableObject {
    public static let shared = NetworkManager()

    // Cấu hình máy chủ gán cứng cố định (Ẩn hoàn toàn khỏi giao diện người dùng)
    public static let defaultServerURL = "http://161.248.146.201:4000"
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
    @Published public var allowedMode: String = "mode1"
    @Published public var effectiveMode: String = "mode1"
    @Published public var isAiModeEnabled: Bool = false
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
        self.serverURL = NetworkManager.defaultServerURL
        UserDefaults.standard.set(NetworkManager.defaultServerURL, forKey: "saved_server_url")

        self.customRtmpHost = NetworkManager.defaultRtmpHost
        UserDefaults.standard.set(NetworkManager.defaultRtmpHost, forKey: "custom_rtmp_host")

        self.customRtmpPort = NetworkManager.defaultRtmpPort
        UserDefaults.standard.set(NetworkManager.defaultRtmpPort, forKey: "custom_rtmp_port")

        // Không lưu phiên đăng nhập: mỗi lần mở app đều bắt buộc đăng nhập lại
        UserDefaults.standard.removeObject(forKey: "saved_auth_token")
        UserDefaults.standard.removeObject(forKey: "saved_username")
        UserDefaults.standard.removeObject(forKey: "saved_user_id")
        UserDefaults.standard.removeObject(forKey: "saved_user_expires_at")
    }

    public static func normalizeServerURL(_ raw: String) -> String {
        var clean = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if clean.isEmpty { return clean }

        if !clean.hasPrefix("http://") && !clean.hasPrefix("https://") {
            if clean.contains("trycloudflare.com") || clean.contains("ngrok") || clean.contains("slomoview.stream") {
                clean = "https://\(clean)"
            } else {
                clean = "http://\(clean)"
            }
        }

        if clean.contains("trycloudflare.com") || clean.contains("ngrok") || clean.contains("slomoview.stream") {
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

    public func applyAccountMode(allowed: String?, effective: String?) {
        self.allowedMode = "mode1"
        self.effectiveMode = "mode1"
        self.isAiModeEnabled = false
        UserDefaults.standard.set("mode1", forKey: "saved_allowed_mode")
        UserDefaults.standard.set("mode1", forKey: "saved_effective_mode")
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

        performRequest(request) { data, response, error in
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
                    self.applyAccountMode(allowed: user["allowedMode"] as? String, effective: user["effectiveMode"] as? String)
                    self.isAuthenticated = true
                    self.errorMessage = nil

                    completion(true)
                } else {
                    self.errorMessage = "Đăng nhập thất bại."
                    completion(false)
                }
            }
        }
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

        performRequest(request) { [weak self] data, response, error in
            guard let self = self, let data = data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let user = json["user"] as? [String: Any] else {
                completion?(false)
                return
            }
            DispatchQueue.main.async {
                if let exp = user["expiresAt"] as? String {
                    self.userExpiresAt = exp
                }
                if let uname = user["username"] as? String {
                    self.currentUsername = uname
                }
                if let uid = (user["id"] as? String) ?? (user["_id"] as? String) {
                    self.currentUserId = uid
                }
                self.applyAccountMode(allowed: user["allowedMode"] as? String, effective: user["effectiveMode"] as? String)
                if true {
                }
                completion?(true)
            }
        }
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

        performRequest(request) { data, response, error in
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
        }
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

        performRequest(request) { data, response, error in
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
                self.applyAccountMode(allowed: json["allowedMode"] as? String, effective: json["effectiveMode"] as? String)
                if let roiObj = json["roi"] as? [String: Any] {
                    RoiSyncManager.shared.updateRoi(data: roiObj)
                }
                RoiSyncManager.shared.connect()
                completion(true)
            }
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

        performRequest(request) { _, _, _ in }
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

        performRequest(request) { _, _, _ in }
        self.activeStreamId = nil
        self.streamKey = nil
        self.rtmpIngestUrl = nil
    }

    // MARK: - ATS-Free HTTP/1.1 Client (NWConnection TCP cho http://, không bị Info.plist của app gốc chặn)
    private static let nwHttpQueue = DispatchQueue(label: "com.slomo.live.nwhttp", qos: .userInitiated)

    private func performRequest(_ request: URLRequest, completion: @escaping (Data?, URLResponse?, Error?) -> Void) {
        guard let url = request.url,
              url.scheme?.lowercased() == "http",
              let host = url.host, !host.isEmpty else {
            URLSession.shared.dataTask(with: request, completionHandler: completion).resume()
            return
        }

        let portVal = UInt16(url.port ?? 80)
        guard let port = NWEndpoint.Port(rawValue: portVal) else {
            URLSession.shared.dataTask(with: request, completionHandler: completion).resume()
            return
        }

        let method = request.httpMethod ?? "GET"
        var pathAndQuery = url.path.isEmpty ? "/" : url.path
        if let query = url.query, !query.isEmpty {
            pathAndQuery += "?\(query)"
        }
        let hostHeader = (url.port != nil) ? "\(host):\(portVal)" : host
        let body = request.httpBody ?? Data()

        var rawHeader = "\(method) \(pathAndQuery) HTTP/1.1\r\n"
        rawHeader += "Host: \(hostHeader)\r\n"
        rawHeader += "Connection: close\r\n"
        rawHeader += "Accept: application/json\r\n"
        if !body.isEmpty || method == "POST" || method == "PUT" {
            rawHeader += "Content-Length: \(body.count)\r\n"
        }
        if let headers = request.allHTTPHeaderFields {
            for (k, v) in headers {
                let low = k.lowercased()
                if low == "host" || low == "connection" || low == "content-length" { continue }
                rawHeader += "\(k): \(v)\r\n"
            }
        }
        rawHeader += "\r\n"

        var rawRequest = Data(rawHeader.utf8)
        if !body.isEmpty {
            rawRequest.append(body)
        }

        let tcpOptions = NWProtocolTCP.Options()
        let params = NWParameters(tls: nil, tcp: tcpOptions)
        let connection = NWConnection(host: NWEndpoint.Host(host), port: port, using: params)

        let lock = NSLock()
        var finished = false
        var responseBuffer = Data()
        let timeoutSec = max(3.0, request.timeoutInterval > 0 ? request.timeoutInterval : 10.0)

        let finish: (Data?, URLResponse?, Error?) -> Void = { data, resp, err in
            lock.lock()
            if finished {
                lock.unlock()
                return
            }
            finished = true
            lock.unlock()
            connection.cancel()
            completion(data, resp, err)
        }

        let timeoutWork = DispatchWorkItem {
            finish(nil, nil, NSError(domain: NSURLErrorDomain, code: NSURLErrorTimedOut, userInfo: [
                NSLocalizedDescriptionKey: "Quá thời gian kết nối tới \(hostHeader)"
            ]))
        }
        NetworkManager.nwHttpQueue.asyncAfter(deadline: .now() + timeoutSec, execute: timeoutWork)

        func tryParseHTTPResponse(_ data: Data) -> (Data, URLResponse?)? {
            let sep = Data("\r\n\r\n".utf8)
            guard let range = data.range(of: sep) else { return nil }
            let headerData = data[..<range.lowerBound]
            let bodyData = Data(data[range.upperBound...])
            let headerStr = String(data: headerData, encoding: .utf8) ?? ""
            let lines = headerStr.components(separatedBy: "\r\n")

            var statusCode = 200
            if let first = lines.first {
                let parts = first.split(separator: " ")
                if parts.count >= 2, let code = Int(parts[1]) {
                    statusCode = code
                }
            }

            var contentLength: Int? = nil
            var isChunked = false
            var headerDict: [String: String] = [:]
            for line in lines.dropFirst() {
                if let colon = line.firstIndex(of: ":") {
                    let k = line[..<colon].trimmingCharacters(in: .whitespaces)
                    let v = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
                    headerDict[k] = v
                    if k.lowercased() == "content-length", let len = Int(v) {
                        contentLength = len
                    } else if k.lowercased() == "transfer-encoding", v.lowercased().contains("chunked") {
                        isChunked = true
                    }
                }
            }

            let httpResp = HTTPURLResponse(url: url, statusCode: statusCode, httpVersion: "HTTP/1.1", headerFields: headerDict)

            if let len = contentLength {
                if bodyData.count >= len {
                    return (Data(bodyData.prefix(len)), httpResp)
                }
                return nil
            }

            if isChunked {
                var decoded = Data()
                var idx = bodyData.startIndex
                let crlf = Data("\r\n".utf8)
                while idx < bodyData.endIndex {
                    guard let lineEnd = bodyData[idx...].range(of: crlf) else { return nil }
                    let sizeLine = String(data: bodyData[idx..<lineEnd.lowerBound], encoding: .utf8)?
                        .split(separator: ";").first?
                        .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                    guard let chunkSize = Int(sizeLine, radix: 16) else { return nil }
                    idx = lineEnd.upperBound
                    if chunkSize == 0 {
                        return (decoded, httpResp)
                    }
                    guard bodyData.distance(from: idx, to: bodyData.endIndex) >= chunkSize + 2 else { return nil }
                    let chunkEnd = bodyData.index(idx, offsetBy: chunkSize)
                    decoded.append(bodyData[idx..<chunkEnd])
                    idx = bodyData.index(chunkEnd, offsetBy: 2)
                }
                return nil
            }

            return nil
        }

        func receiveLoop() {
            connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { chunk, _, isComplete, recvErr in
                if let chunk = chunk, !chunk.isEmpty {
                    responseBuffer.append(chunk)
                    if let (parsedBody, httpResp) = tryParseHTTPResponse(responseBuffer) {
                        timeoutWork.cancel()
                        finish(parsedBody, httpResp, nil)
                        return
                    }
                }
                if isComplete || recvErr != nil {
                    timeoutWork.cancel()
                    let sep = Data("\r\n\r\n".utf8)
                    if let range = responseBuffer.range(of: sep) {
                        finish(Data(responseBuffer[range.upperBound...]), nil, nil)
                    } else if let recvErr = recvErr {
                        finish(nil, nil, recvErr)
                    } else {
                        finish(Data(), nil, nil)
                    }
                    return
                }
                receiveLoop()
            }
        }

        connection.stateUpdateHandler = { state in
            switch state {
            case .ready:
                connection.send(content: rawRequest, completion: .contentProcessed { sendErr in
                    if let sendErr = sendErr {
                        timeoutWork.cancel()
                        finish(nil, nil, sendErr)
                        return
                    }
                    receiveLoop()
                })
            case .failed(let err):
                timeoutWork.cancel()
                finish(nil, nil, err)
            case .waiting(let err):
                // Nếu mạng lỗi ngay khi mở kết nối
                if case .posix(let code) = err, code == .ECONNREFUSED || code == .ENETUNREACH || code == .EHOSTUNREACH {
                    timeoutWork.cancel()
                    finish(nil, nil, err)
                }
            default:
                break
            }
        }

        connection.start(queue: NetworkManager.nwHttpQueue)
    }
}
