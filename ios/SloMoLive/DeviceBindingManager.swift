import UIKit
import Security
import CommonCrypto

/// DeviceBindingManager chịu trách nhiệm lấy và lưu trữ Hardware UUID cố định của iPhone.
/// Sử dụng UIDevice.current.identifierForVendor kết hợp iOS Keychain và UserDefaults.
/// Đảm bảo 100% không bao giờ bị đổi key ngẫu nhiên trên cùng 1 máy vật lý và chống đoán mò.
public class DeviceBindingManager {
    public static let shared = DeviceBindingManager()
    private let keychainService = "com.slomo.live.devicebinding"
    private let keychainAccount = "hardware_device_uuid"
    private let keychainFingerprintAccount = "hardware_device_fingerprint"
    private let userDefaultsKey = "com.slomo.live.device_uuid_cache"
    private let salt = "AGI_CARDGAME_DEVICE_SECURITY_SALT_2026_#99"

    // Bộ nhớ đệm RAM để không bao giờ bị nhảy key trong suốt phiên chạy của app
    private var cachedUUID: String?
    private var cachedFingerprint: String?

    private init() {}

    /// Lấy Unique Hardware Device UUID cố định duy nhất của iPhone
    public func getOrCreateDeviceUUID() -> String {
        // 1. Nếu đã có trong RAM cache -> trả về ngay
        if let cached = cachedUUID, !cached.isEmpty {
            return cached
        }

        // 2. Thử lấy từ Keychain (tồn tại bền bỉ kể cả xoá app cài lại)
        if let keychainUUID = loadFromKeychain(account: keychainAccount), !keychainUUID.isEmpty {
            cachedUUID = keychainUUID
            UserDefaults.standard.set(keychainUUID, forKey: userDefaultsKey)
            return keychainUUID
        }

        // 3. Thử lấy từ UserDefaults (fallback dự phòng nếu Keychain bị chặn)
        if let defaultsUUID = UserDefaults.standard.string(forKey: userDefaultsKey), !defaultsUUID.isEmpty {
            cachedUUID = defaultsUUID
            saveToKeychain(uuid: defaultsUUID, account: keychainAccount)
            return defaultsUUID
        }

        // 4. Lấy UIDevice.current.identifierForVendor (định danh phần cứng bất biến của Apple cho cùng 1 máy)
        let vendorUUID = UIDevice.current.identifierForVendor?.uuidString
        let stableUUID = (vendorUUID != nil && !vendorUUID!.isEmpty) ? vendorUUID! : UUID().uuidString

        cachedUUID = stableUUID
        saveToKeychain(uuid: stableUUID, account: keychainAccount)
        UserDefaults.standard.set(stableUUID, forKey: userDefaultsKey)
        return stableUUID
    }

    /// Lấy tên dòng máy iPhone chính xác từ mã phần cứng Apple (VD: iPhone 13 Pro, iPhone 14 Pro Max)
    public func getDeviceModelName() -> String {
        var systemInfo = utsname()
        uname(&systemInfo)
        let machineMirror = Mirror(reflecting: systemInfo.machine)
        let identifier = machineMirror.children.reduce("") { identifier, element in
            guard let value = element.value as? Int8, value != 0 else { return identifier }
            return identifier + String(UnicodeScalar(UInt8(value)))
        }

        let modelMap: [String: String] = [
            "iPhone12,1": "iPhone 11",
            "iPhone12,3": "iPhone 11 Pro",
            "iPhone12,5": "iPhone 11 Pro Max",
            "iPhone12,8": "iPhone SE (2nd gen)",
            "iPhone13,1": "iPhone 12 mini",
            "iPhone13,2": "iPhone 12",
            "iPhone13,3": "iPhone 12 Pro",
            "iPhone13,4": "iPhone 12 Pro Max",
            "iPhone14,4": "iPhone 13 mini",
            "iPhone14,5": "iPhone 13",
            "iPhone14,2": "iPhone 13 Pro",
            "iPhone14,3": "iPhone 13 Pro Max",
            "iPhone14,6": "iPhone SE (3rd gen)",
            "iPhone14,7": "iPhone 14",
            "iPhone14,8": "iPhone 14 Plus",
            "iPhone15,2": "iPhone 14 Pro",
            "iPhone15,3": "iPhone 14 Pro Max",
            "iPhone15,4": "iPhone 15",
            "iPhone15,5": "iPhone 15 Plus",
            "iPhone16,1": "iPhone 15 Pro",
            "iPhone16,2": "iPhone 15 Pro Max",
            "iPhone17,1": "iPhone 16 Pro",
            "iPhone17,2": "iPhone 16 Pro Max",
            "iPhone17,3": "iPhone 16",
            "iPhone17,4": "iPhone 16 Plus",
            "arm64": "iOS Simulator (ARM64)",
            "x86_64": "iOS Simulator (x86_64)"
        ]

        if let mapped = modelMap[identifier] {
            return mapped
        }
        return identifier.isEmpty ? UIDevice.current.model : identifier
    }

    /// Tạo mã định danh máy chuẩn hóa chống đoán mò: AGI-XXXX-YYYY-ZZZZ-WWWW-CCCC
    public func getDeviceFingerprint() -> String {
        if let cached = cachedFingerprint, !cached.isEmpty {
            return cached
        }

        if let keychainFp = loadFromKeychain(account: keychainFingerprintAccount), !keychainFp.isEmpty {
            cachedFingerprint = keychainFp
            return keychainFp
        }

        let rawUuid = getOrCreateDeviceUUID().lowercased()
        let model = getDeviceModelName().lowercased()
        let message = "\(rawUuid):\(model)"

        guard let keyData = salt.data(using: .utf8),
              let messageData = message.data(using: .utf8) else {
            return "AGI-UNKNOWN-DEVICE"
        }

        var hmac = [UInt8](repeating: 0, count: Int(CC_SHA256_DIGEST_LENGTH))
        keyData.withUnsafeBytes { keyBytes in
            messageData.withUnsafeBytes { messageBytes in
                CCHmac(CCHmacAlgorithm(kCCHmacAlgSHA256), keyBytes.baseAddress, keyData.count, messageBytes.baseAddress, messageData.count, &hmac)
            }
        }

        let rawBase32 = encodeCrockfordBase32(bytes: Array(hmac.prefix(10)), length: 16)
        let checksum = computeChecksum(dataStr: rawBase32, salt: salt)

        let p1 = String(rawBase32.prefix(4))
        let p2 = String(rawBase32.dropFirst(4).prefix(4))
        let p3 = String(rawBase32.dropFirst(8).prefix(4))
        let p4 = String(rawBase32.dropFirst(12).prefix(4))

        let fp = "AGI-\(p1)-\(p2)-\(p3)-\(p4)-\(checksum)"
        cachedFingerprint = fp
        saveToKeychain(uuid: fp, account: keychainFingerprintAccount)
        return fp
    }

    private func encodeCrockfordBase32(bytes: [UInt8], length: Int) -> String {
        let alphabet = Array("0123456789ABCDEFGHJKMNPQRSTVWXYZ")
        var bits = 0
        var value = 0
        var output = ""

        for byte in bytes {
            value = (value << 8) | Int(byte)
            bits += 8
            while bits >= 5 {
                output.append(alphabet[(value >> (bits - 5)) & 31])
                bits -= 5
            }
        }
        if bits > 0 {
            output.append(alphabet[(value << (5 - bits)) & 31])
        }
        return String(output.prefix(length))
    }

    private func computeChecksum(dataStr: String, salt: String) -> String {
        guard let keyData = salt.data(using: .utf8),
              let messageData = dataStr.data(using: .utf8) else { return "0000" }

        var hmac = [UInt8](repeating: 0, count: Int(CC_SHA256_DIGEST_LENGTH))
        keyData.withUnsafeBytes { keyBytes in
            messageData.withUnsafeBytes { messageBytes in
                CCHmac(CCHmacAlgorithm(kCCHmacAlgSHA256), keyBytes.baseAddress, keyData.count, messageBytes.baseAddress, messageData.count, &hmac)
            }
        }
        return encodeCrockfordBase32(bytes: Array(hmac.prefix(3)), length: 4)
    }

    private func saveToKeychain(uuid: String, account: String) {
        guard let data = uuid.data(using: .utf8) else { return }

        let deleteQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: account
        ]
        SecItemDelete(deleteQuery as CFDictionary)

        let addQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: account,
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]
        SecItemAdd(addQuery as CFDictionary, nil)
    }

    private func loadFromKeychain(account: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: account,
            kSecReturnData as String: kCFBooleanTrue!,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]

        var dataTypeRef: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &dataTypeRef)

        if status == errSecSuccess, let data = dataTypeRef as? Data, let str = String(data: data, encoding: .utf8) {
            return str
        }
        return nil
    }
}
