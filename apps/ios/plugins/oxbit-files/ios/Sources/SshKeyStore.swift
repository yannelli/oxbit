import Foundation
import Security

struct SshKeyRecord: Codable {
  let id: String
  let name: String
  let algorithm: String
  let fingerprint: String
  let publicKey: String
  let privateKey: String
  let created: Double
}

func sshKeyFailure(_ message: String) -> NSError {
  NSError(domain: "OxbitSshKeys", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
}

/// Keychain items for SSH private keys (JSON records) and saved host passwords.
/// The services are parameters so the macOS harness in Tests/SshKeys uses its own items.
struct SshKeyStore {
  var keyService = "com.yannelli.oxbit.ssh-key"
  var passwordService = "com.yannelli.oxbit.ssh-password"

  static func identifier(_ value: String?) throws -> String {
    guard let value, let uuid = UUID(uuidString: value), uuid.uuidString.lowercased() == value.lowercased() else {
      throw sshKeyFailure("Invalid SSH key request.")
    }
    return value
  }

  static func validated(id: String?, name: String?, algorithm: String?, fingerprint: String?,
    publicKey: String?, privateKey: String?) throws -> SshKeyRecord {
    let id = try identifier(id)
    guard let name, !name.isEmpty, name.count <= 64,
      let algorithm, !algorithm.isEmpty, algorithm.utf8.count <= 64,
      let fingerprint, fingerprint.hasPrefix("SHA256:"), fingerprint.utf8.count <= 128,
      let publicKey, publicKey.hasPrefix(algorithm + " "), publicKey.utf8.count <= 16_384,
      let privateKey, privateKey.hasPrefix("-----BEGIN OPENSSH PRIVATE KEY-----"),
      privateKey.utf8.count <= 32_768
    else { throw sshKeyFailure("The SSH key could not be saved.") }
    return SshKeyRecord(id: id, name: name, algorithm: algorithm, fingerprint: fingerprint,
      publicKey: publicKey, privateKey: privateKey, created: Date().timeIntervalSince1970)
  }

  /// Lists accounts, then reads each item: the macOS file-based keychain rejects
  /// `kSecReturnData` with `kSecMatchLimitAll` (errSecParam).
  func keys() throws -> [SshKeyRecord] {
    let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: keyService,
      kSecReturnAttributes as String: true,
      kSecMatchLimit as String: kSecMatchLimitAll]
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return [] }
    guard status == errSecSuccess else { throw sshKeyFailure("Could not access SSH keys on this device.") }
    let accounts = ((result as? [[String: Any]]) ?? []).compactMap { $0[kSecAttrAccount as String] as? String }
    return try accounts.compactMap { account in
      try read(service: keyService, account: account).flatMap { try? JSONDecoder().decode(SshKeyRecord.self, from: $0) }
    }.sorted { $0.created < $1.created }
  }

  func key(_ id: String?) throws -> SshKeyRecord? {
    let id = try Self.identifier(id)
    return try keys().first { $0.id == id }
  }

  func save(_ record: SshKeyRecord) throws {
    try store(service: keyService, account: record.id, data: try JSONEncoder().encode(record))
  }

  func deleteKey(_ id: String?) throws {
    try remove(service: keyService, account: try Self.identifier(id))
  }

  func savePassword(_ password: String?, host: String?) throws {
    guard let password, !password.isEmpty, password.utf8.count <= 1_024 else {
      throw sshKeyFailure("Enter a password of up to 1024 bytes.")
    }
    try store(service: passwordService, account: try Self.identifier(host), data: Data(password.utf8))
  }

  func password(host: String?) throws -> String? {
    let data = try read(service: passwordService, account: try Self.identifier(host))
    return data.flatMap { String(data: $0, encoding: .utf8) }
  }

  func forgetPassword(host: String?) throws {
    try remove(service: passwordService, account: try Self.identifier(host))
  }

  private func read(service: String, account: String) throws -> Data? {
    let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service, kSecAttrAccount as String: account,
      kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess else { throw sshKeyFailure("Could not access the Keychain on this device.") }
    return result as? Data
  }

  private func store(service: String, account: String, data: Data) throws {
    let existing: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service, kSecAttrAccount as String: account]
    let values: [String: Any] = [kSecValueData as String: data,
      kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
    var status = SecItemUpdate(existing as CFDictionary, values as CFDictionary)
    if status == errSecItemNotFound {
      status = SecItemAdd(existing.merging(values) { _, value in value } as CFDictionary, nil)
    }
    guard status == errSecSuccess else { throw sshKeyFailure("Could not save to the Keychain on this device.") }
  }

  private func remove(service: String, account: String) throws {
    let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service, kSecAttrAccount as String: account]
    let status = SecItemDelete(query as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw sshKeyFailure("Could not remove the item from the Keychain.")
    }
  }
}
