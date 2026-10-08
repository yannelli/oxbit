import Foundation
import Security
import Tauri

private struct SshKeyArgs: Decodable {
  let operation: String
  let id: String?
  let hostId: String?
  let name: String?
  let algorithm: String?
  let fingerprint: String?
  let publicKey: String?
  let privateKey: String?
  let password: String?
}

private struct SshKeyRecord: Codable {
  let id: String
  let name: String
  let algorithm: String
  let fingerprint: String
  let publicKey: String
  let privateKey: String
  let created: Double
}

private func sshKeyFailure(_ message: String) -> NSError {
  NSError(domain: "OxbitSshKeys", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
}

/// Private keys and saved host passwords in the Keychain. `list` and `delete` are the only
/// operations the WebView reaches; the Rust plugin layer strips secrets from their results.
final class SshKeys {
  private let queue = DispatchQueue(label: "com.yannelli.oxbit.ssh-keys")
  private let keyService = "com.yannelli.oxbit.ssh-key"
  private let passwordService = "com.yannelli.oxbit.ssh-password"

  func handle(_ invoke: Invoke) {
    let args: SshKeyArgs
    do {
      args = try invoke.parseArgs(SshKeyArgs.self)
    } catch {
      invoke.reject("Invalid SSH key request.", code: "SSH_KEYS")
      return
    }
    queue.async { self.process(args, invoke: invoke) }
  }

  private func process(_ args: SshKeyArgs, invoke: Invoke) {
    do {
      switch args.operation {
      case "list":
        invoke.resolve(["keys": try records().map(metadata)])
      case "save":
        let record = try validated(args)
        try store(service: keyService, account: record.id, data: try JSONEncoder().encode(record))
        invoke.resolve(metadata(record))
      case "read":
        let id = try identifier(args.id)
        guard let record = try records().first(where: { $0.id == id }) else {
          throw sshKeyFailure("This SSH key is no longer on this device.")
        }
        invoke.resolve(["privateKey": record.privateKey])
      case "delete":
        try remove(service: keyService, account: try identifier(args.id))
        invoke.resolve(["keys": try records().map(metadata)])
      case "savePassword":
        guard let password = args.password, !password.isEmpty, password.utf8.count <= 1_024 else {
          throw sshKeyFailure("Enter a password of up to 1024 bytes.")
        }
        try store(service: passwordService, account: try identifier(args.hostId), data: Data(password.utf8))
        invoke.resolve()
      case "readPassword":
        let data = try read(service: passwordService, account: try identifier(args.hostId))
        invoke.resolve(data.flatMap { String(data: $0, encoding: .utf8) }.map { ["password": $0] } ?? [:])
      case "forgetPassword":
        try remove(service: passwordService, account: try identifier(args.hostId))
        invoke.resolve()
      default:
        throw sshKeyFailure("Unknown SSH key operation.")
      }
    } catch {
      let message = (error as NSError).domain == "OxbitSshKeys"
        ? error.localizedDescription : "The SSH key request failed."
      invoke.reject(message, code: "SSH_KEYS")
    }
  }

  private func identifier(_ value: String?) throws -> String {
    guard let value, let uuid = UUID(uuidString: value), uuid.uuidString.lowercased() == value.lowercased() else {
      throw sshKeyFailure("Invalid SSH key request.")
    }
    return value
  }

  private func validated(_ args: SshKeyArgs) throws -> SshKeyRecord {
    let id = try identifier(args.id)
    guard let name = args.name, !name.isEmpty, name.count <= 64,
      let algorithm = args.algorithm, !algorithm.isEmpty, algorithm.utf8.count <= 64,
      let fingerprint = args.fingerprint, fingerprint.hasPrefix("SHA256:"), fingerprint.utf8.count <= 128,
      let publicKey = args.publicKey, publicKey.hasPrefix(algorithm + " "), publicKey.utf8.count <= 16_384,
      let privateKey = args.privateKey, privateKey.hasPrefix("-----BEGIN OPENSSH PRIVATE KEY-----"),
      privateKey.utf8.count <= 32_768
    else { throw sshKeyFailure("The SSH key could not be saved.") }
    return SshKeyRecord(id: id, name: name, algorithm: algorithm, fingerprint: fingerprint,
      publicKey: publicKey, privateKey: privateKey, created: Date().timeIntervalSince1970)
  }

  private func metadata(_ record: SshKeyRecord) -> [String: Any] {
    ["id": record.id, "name": record.name, "algorithm": record.algorithm,
     "fingerprint": record.fingerprint, "publicKey": record.publicKey]
  }

  private func records() throws -> [SshKeyRecord] {
    let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: keyService,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitAll]
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return [] }
    guard status == errSecSuccess else { throw sshKeyFailure("Could not access SSH keys on this device.") }
    let items = (result as? [Data]) ?? []
    return items.compactMap { try? JSONDecoder().decode(SshKeyRecord.self, from: $0) }
      .sorted { $0.created < $1.created }
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
