import Foundation
import Security
import UIKit

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
        if let existingUUID = loadFromKeychain(), !existingUUID.isEmpty {
            return existingUUID
        }
        
        // Ưu tiên dùng identifierForVendor của Apple (cố định theo phần cứng máy cho nhà phát triển này)
        // thay vì gọi UUID().uuidString hoàn toàn ngẫu nhiên.
        let persistentUUID = UIDevice.current.identifierForVendor?.uuidString ?? UUID().uuidString
        saveToKeychain(uuid: persistentUUID)
        return persistentUUID
    }

    private func saveToKeychain(uuid: String) {
        guard let data = uuid.data(using: .utf8) else { return }
        
        // BƯỚC 1: Xóa item cũ.
        // QUAN TRỌNG: Query xóa CHỈ ĐƯỢC CHỨA các thuộc tính định danh (kSecClass, kSecAttrService, kSecAttrAccount).
        // Tuyệt đối không đưa kSecValueData hay kSecAttrAccessible vào vì SecItemDelete sẽ trả về errSecParam (-50)
        // và không chịu xóa, dẫn đến SecItemAdd ở bước 2 bị lỗi errSecDuplicateItem (-25299)!
        let deleteQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainAccount
        ]
        SecItemDelete(deleteQuery as CFDictionary)
        
        // BƯỚC 2: Thêm item mới với thuộc tính ThisDeviceOnly để khoá chặt vào thiết bị vật lý này
        let addQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainAccount,
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]

        let status = SecItemAdd(addQuery as CFDictionary, nil)
        if status != errSecSuccess {
            print("[DeviceBindingManager] Cảnh báo: SecItemAdd trả về mã lỗi: \(status)")
        } else {
            print("[DeviceBindingManager] Đã lưu cố định Hardware UUID vào Keychain thành công.")
        }
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
