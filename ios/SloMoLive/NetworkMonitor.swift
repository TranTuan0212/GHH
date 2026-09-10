import Foundation
import Network
import Combine

/// NetworkMonitor xác định loại kết nối mạng hiện tại của iPhone:
///   - WiFi (LAN/WLAN): iPhone và server CÙNG mạng → dùng IP LAN
///   - Cellular (4G/5G): iPhone qua data di động → KHÔNG truy cập được IP LAN
///
/// Khi dùng Cellular, user BẮT BUỘC phải:
///   1) Server mở port 1935 ra public (vd: Cloudflare Tunnel cho TCP), HOẶC
///   2) User điền "RTMP Host Override" trong UI (vd: tunnel host riêng cho port 1935).
///
/// Class này publish `currentInterface` qua @Published để UI có thể hiển thị
/// cảnh báo rõ ràng (vd: "Đang dùng 5G — cần RTMP Host Override nếu server không public").
public class NetworkMonitor: ObservableObject {
    public static let shared = NetworkMonitor()

    public enum NetworkInterface: String {
        case wifi = "WiFi"
        case cellular = "Cellular (4G/5G)"
        case wired = "Wired Ethernet"
        case unknown = "Unknown"
        case offline = "Offline"
    }

    @Published public var currentInterface: NetworkInterface = .unknown
    @Published public var isReachable: Bool = false
    @Published public var isExpensive: Bool = false   // cellular thường isExpensive=true
    @Published public var interfaceDescription: String = ""

    private let monitor = NWPathMonitor()
    private let queue = DispatchQueue(label: "com.slomo.network.monitor")

    private init() {
        monitor.pathUpdateHandler = { [weak self] path in
            DispatchQueue.main.async {
                self?.updateInterface(path: path)
            }
        }
        monitor.start(queue: queue)
    }

    private func updateInterface(path: NWPath) {
        self.isReachable = path.status == .satisfied
        self.isExpensive = path.isExpensive

        let interface: NetworkInterface
        var desc = ""

        if path.status == .satisfied {
            if path.usesInterfaceType(.wifi) {
                interface = .wifi
                desc = "iPhone đang dùng WiFi"
            } else if path.usesInterfaceType(.cellular) {
                interface = .cellular
                desc = "iPhone đang dùng 4G/5G — KHÔNG truy cập được IP LAN của server. Cần RTMP Host Override."
            } else if path.usesInterfaceType(.wiredEthernet) {
                interface = .wired
                desc = "iPhone đang dùng Ethernet (qua adapter)"
            } else {
                interface = .unknown
                desc = "Loại mạng không xác định"
            }
        } else {
            interface = .offline
            desc = "Không có kết nối mạng"
        }

        if self.currentInterface != interface {
            print("[NetworkMonitor] 🔄 Chuyển mạng: \(self.currentInterface.rawValue) → \(interface.rawValue). \(desc)")
        }
        self.currentInterface = interface
        self.interfaceDescription = desc
    }

    /// Detect xem URL có phải IP LAN hay public domain.
    /// Trả về true nếu là IP (vd: 192.145.x.x, 10.x.x.x, 172.16-31.x.x) - thường chỉ truy cập được trong LAN.
    public static func isLikelyLanIP(_ host: String) -> Bool {
        let parts = host.split(separator: ".")
        guard parts.count == 4 else { return false }
        guard let first = Int(parts[0]), let second = Int(parts[1]) else { return false }
        // 10.0.0.0/8
        if first == 10 { return true }
        // 172.16.0.0/12
        if first == 172 && second >= 16 && second <= 31 { return true }
        // 192.168.0.0/16
        if first == 192 && second == 168 { return true }
        // 169.254.0.0/16 (link-local)
        if first == 169 && second == 254 { return true }
        // 127.0.0.0/8 (loopback - không LAN thật)
        if first == 127 { return false }
        // Còn lại (vd: 192.145.x.x ở VN có thể là public IP)
        // Trả false để tránh nhầm - user phải tự override nếu cần
        return false
    }

    /// Cảnh báo nếu user đang dùng Cellular mà ingestUrl là IP LAN.
    public func shouldWarnAboutRTMP(_ ingestUrl: String) -> String? {
        guard currentInterface == .cellular else { return nil }
        // Parse host từ rtmp://host:port/...
        let stripped = ingestUrl
            .replacingOccurrences(of: "rtmp://", with: "")
            .replacingOccurrences(of: "rtmps://", with: "")
        let host = stripped.split(separator: ":").first.map(String.init) ?? stripped
        if NetworkMonitor.isLikelyLanIP(host) {
            return "⚠️ Đang dùng 4G/5G nhưng RTMP server là IP LAN (\(host)). iPhone không thể kết nối trực tiếp. Vui lòng điền 'RTMP Host Override' (vd: tunnel host cho port 1935)."
        }
        return nil
    }
}
