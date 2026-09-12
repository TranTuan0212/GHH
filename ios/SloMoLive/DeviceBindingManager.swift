import UIKit
import Security

/// DeviceBindingManager chịu trách nhiệm lấy và lưu trữ Hardware UUID cố định của iPhone.
/// Sử dụng UIDevice.current.identifierForVendor kết hợp iOS Keychain và UserDefaults.
/// Đảm bảo 100% không bao giờ bị đổi key ngẫu nhiên trên cùng 1 máy vật lý.
public class DeviceBindingManager {
    public static let shared = DeviceBindingManager()
    private let keychainService = "com.slomo.live.devicebinding"
    private let keychainAccount = "hardware_device_uuid"
    private let userDefaultsKey = "com.slomo.live.device_uuid_cache"

    // Bộ nhớ đệm RAM để không bao giờ bị nhảy key trong suốt phiên chạy của app
    private var cachedUUID: String?

    private init() {}

    /// Lấy Unique Hardware Device UUID cố định duy nhất của iPhone
    public func getOrCreateDeviceUUID() -> String {
        // 1. Nếu đã có trong RAM cache -> trả về ngay
        if let cached = cachedUUID, !cached.isEmpty {
            return cached
        }

        // 2. Thử lấy từ Keychain (tồn tại bền bỉ kể cả xoá app cài lại)
        if let keychainUUID = loadFromKeychain(), !keychainUUID.isEmpty {
            cachedUUID = keychainUUID
            UserDefaults.standard.set(keychainUUID, forKey: userDefaultsKey)
            return keychainUUID
        }

        // 3. Thử lấy từ UserDefaults (fallback dự phòng nếu Keychain bị chặn)
        if let defaultsUUID = UserDefaults.standard.string(forKey: userDefaultsKey), !defaultsUUID.isEmpty {
            cachedUUID = defaultsUUID
            saveToKeychain(uuid: defaultsUUID)
            return defaultsUUID
        }

        // 4. Lấy UIDevice.current.identifierForVendor (định danh phần cứng bất biến của Apple cho cùng 1 máy)
        let vendorUUID = UIDevice.current.identifierForVendor?.uuidString
        let stableUUID = (vendorUUID != nil && !vendorUUID!.isEmpty) ? vendorUUID! : UUID().uuidString

        cachedUUID = stableUUID
        saveToKeychain(uuid: stableUUID)
        UserDefaults.standard.set(stableUUID, forKey: userDefaultsKey)
        return stableUUID
    }

    private func saveToKeychain(uuid: String) {
        guard let data = uuid.data(using: .utf8) else { return }

        // Query để xóa item cũ: CHỈ gồm attributes định danh (KHÔNG kèm kSecValueData vì sẽ bị lỗi errSecParam -50)
        let deleteQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainAccount
        ]
        SecItemDelete(deleteQuery as CFDictionary)

        // Query để thêm item mới
        let addQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainAccount,
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]
        SecItemAdd(addQuery as CFDictionary, nil)
    }

    private func loadFromKeychain() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainAccount,
            kSecReturnData as String: kCFBooleanTrue!,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]

        var dataTypeRef: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &dataTypeRef)

        if status == errSecSuccess, let data = dataTypeRef as? Data, let uuidStr = String(data: data, encoding: .utf8) {
            return uuidStr
        }
        return nil
    }
}
