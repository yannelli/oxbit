import Foundation
import Security
import Tauri

private struct DeviceSecretArgs: Decodable {
  let operation: String
  let name: String
  let value: String?
}

/// Named secrets that stay on this device, such as the remote access device key.
final class DeviceSecrets {
  private let service = "com.yannelli.oxbit.secret"

  func handle(_ invoke: Invoke) {
    do {
      let args = try invoke.parseArgs(DeviceSecretArgs.self)
      guard args.name.range(of: "^[a-z0-9][a-z0-9.-]{0,63}$", options: .regularExpression) != nil else {
        throw failure("The secret name is invalid.")
      }
      switch args.operation {
      case "get":
        invoke.resolve(try read(args.name).map { ["value": $0] } ?? [:])
      case "set":
        guard let value = args.value else { throw failure("The secret value is missing.") }
        try save(value, account: args.name)
        invoke.resolve([String: String]())
      case "delete":
        try delete(args.name)
        invoke.resolve([String: String]())
      default:
        throw failure("Unknown device secret operation.")
      }
    } catch {
      invoke.reject(error.localizedDescription, code: "DEVICE_SECRET")
    }
  }

  private func query(_ account: String) -> [String: Any] {
    [kSecClass as String: kSecClassGenericPassword,
     kSecAttrService as String: service, kSecAttrAccount as String: account]
  }

  private func read(_ account: String) throws -> String? {
    var attributes = query(account)
    attributes[kSecReturnData as String] = true
    attributes[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(attributes as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess else { throw keychainError(status) }
    guard let data = result as? Data, let value = String(data: data, encoding: .utf8) else {
      throw failure("The saved secret could not be read.")
    }
    return value
  }

  private func delete(_ account: String) throws {
    let status = SecItemDelete(query(account) as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else { throw keychainError(status) }
  }

  private func save(_ value: String, account: String) throws {
    let values: [String: Any] = [kSecValueData as String: Data(value.utf8),
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
    let existing = query(account)
    var status = SecItemUpdate(existing as CFDictionary, values as CFDictionary)
    if status == errSecItemNotFound {
      status = SecItemAdd(existing.merging(values) { _, value in value } as CFDictionary, nil)
    }
    guard status == errSecSuccess else { throw keychainError(status) }
  }

  private func failure(_ message: String) -> NSError {
    NSError(domain: "OxbitDeviceSecret", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
  }

  private func keychainError(_ status: OSStatus) -> NSError {
    failure("Could not access the device secret: \(SecCopyErrorMessageString(status, nil) as String? ?? String(status))")
  }
}
