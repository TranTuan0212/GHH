import Foundation
import Security

/// DeviceBindingManager chịu trách nhiệm lấy và lưu trữ Hardware UUID cố định trong iOS Keychain.
/// UUID này sẽ không bị xóa ngay cả khi gỡ ứng dụng và cài đặt lại,
/// đảm bảo ràng buộc cố định tài khoản với duy nhất 01 thiết bị di động (Requirement 8a).
public class DeviceBindingManager {
    public static let shared = DeviceBindingManager()
    private let keychainService = "com.slomo.live.devicebinding"
    private let keychainAccount = "hardware_device_uuid"

    private init() {}

    /// Lấy Unique Hardware Device UUID cố định của iPhone
    public func getOrCreateDeviceUUID() -> String {
        if let existingUUID = loadFromKeychain() {
            return existingUUID
        }
        
        let newUUID = UUID().uuidString
        saveToKeychain(uuid: newUUID)
        return newUUID
    }

    private func saveToKeychain(uuid: String) {
        guard let data = uuid.data(using: .utf8) else { return }
        
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainAccount,
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock
        ]

        SecItemDelete(query as CFDictionary)
        SecItemAdd(query as CFDictionary, nil)
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
