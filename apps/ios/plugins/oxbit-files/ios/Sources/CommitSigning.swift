import Foundation
import Security
import Tauri

private struct CommitSigningArgs: Decodable {
  let operation: String
  let secretKey: String?
  let enabled: Bool?
}

private struct CommitSigningProfile: Codable {
  var secretKey: String?
  var enabled = false
}

private let maximumSecretKeyBytes = 131_072

private func commitSigningFailure(_ message: String) -> NSError {
  NSError(domain: "OxbitCommitSigning", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
}

/// Keeps the commit signing key in the Keychain. Rust validates requests and parses the key;
/// every response carries the stored key, so only the Rust command layer calls this.
final class CommitSigning {
  private let queue = DispatchQueue(label: "com.yannelli.oxbit.commit-signing")

  func handle(_ invoke: Invoke) {
    let args: CommitSigningArgs
    do {
      args = try invoke.parseArgs(CommitSigningArgs.self)
    } catch {
      invoke.reject("Invalid commit signing request.", code: "COMMIT_SIGNING")
      return
    }
    queue.async { self.process(args, invoke: invoke) }
  }

  private func process(_ args: CommitSigningArgs, invoke: Invoke) {
    do {
      var profile = args.operation == "remove" ? CommitSigningProfile() : try read()
      switch args.operation {
      case "read":
        break
      case "save":
        guard let secretKey = args.secretKey, !secretKey.isEmpty,
          secretKey.utf8.count <= maximumSecretKeyBytes
        else { throw commitSigningFailure("The signing key is too large to save.") }
        profile.secretKey = secretKey
        try save(profile)
      case "setEnabled":
        guard let enabled = args.enabled else { throw commitSigningFailure("Choose whether to sign commits.") }
        guard profile.secretKey != nil else { throw commitSigningFailure("Add a signing key first.") }
        profile.enabled = enabled
        try save(profile)
      case "remove":
        try remove()
      default:
        throw commitSigningFailure("Unknown commit signing operation.")
      }
      var result: [String: Any] = ["enabled": profile.enabled]
      if let secretKey = profile.secretKey { result["secretKey"] = secretKey }
      invoke.resolve(result)
    } catch {
      let message = (error as NSError).domain == "OxbitCommitSigning"
        ? error.localizedDescription : "The commit signing request failed."
      invoke.reject(message, code: "COMMIT_SIGNING")
    }
  }

  private func query() -> [String: Any] {
    [kSecClass as String: kSecClassGenericPassword,
     kSecAttrService as String: "com.yannelli.oxbit.commit-signing",
     kSecAttrAccount as String: "openpgp"]
  }

  private func read() throws -> CommitSigningProfile {
    var attributes = query()
    attributes[kSecReturnData as String] = true
    attributes[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(attributes as CFDictionary, &result)
    if status == errSecItemNotFound { return CommitSigningProfile() }
    if status == errSecInteractionNotAllowed {
      throw commitSigningFailure("Unlock this device to use the commit signing key.")
    }
    guard status == errSecSuccess else { throw commitSigningFailure("Could not access the commit signing key on this device.") }
    guard let data = result as? Data, data.count <= maximumSecretKeyBytes + 1_024,
      let profile = try? JSONDecoder().decode(CommitSigningProfile.self, from: data),
      profile.secretKey != nil || !profile.enabled
    else { throw commitSigningFailure("The saved commit signing key could not be read.") }
    return profile
  }

  private func save(_ profile: CommitSigningProfile) throws {
    let data = try JSONEncoder().encode(profile)
    let values: [String: Any] = [kSecValueData as String: data,
      kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
    let existing = query()
    var status = SecItemUpdate(existing as CFDictionary, values as CFDictionary)
    if status == errSecItemNotFound {
      status = SecItemAdd(existing.merging(values) { _, value in value } as CFDictionary, nil)
    }
    guard status == errSecSuccess else { throw commitSigningFailure("Could not save the commit signing key on this device.") }
  }

  private func remove() throws {
    let status = SecItemDelete(query() as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw commitSigningFailure("Could not remove the commit signing key from this device.")
    }
  }
}
