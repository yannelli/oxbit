import Foundation
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

/// Private keys and saved host passwords in the Keychain. `list` and `delete` are the only
/// operations the WebView reaches; the Rust plugin layer strips secrets from their results.
final class SshKeys {
  private let queue = DispatchQueue(label: "com.yannelli.oxbit.ssh-keys")
  private let store = SshKeyStore()

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
        invoke.resolve(["keys": try store.keys().map(metadata)])
      case "save":
        let record = try SshKeyStore.validated(id: args.id, name: args.name, algorithm: args.algorithm,
          fingerprint: args.fingerprint, publicKey: args.publicKey, privateKey: args.privateKey)
        try store.save(record)
        invoke.resolve(metadata(record))
      case "read":
        guard let record = try store.key(args.id) else {
          throw sshKeyFailure("This SSH key is no longer on this device.")
        }
        invoke.resolve(["privateKey": record.privateKey])
      case "delete":
        try store.deleteKey(args.id)
        invoke.resolve(["keys": try store.keys().map(metadata)])
      case "savePassword":
        try store.savePassword(args.password, host: args.hostId)
        invoke.resolve()
      case "readPassword":
        invoke.resolve(try store.password(host: args.hostId).map { ["password": $0] } ?? [:])
      case "forgetPassword":
        try store.forgetPassword(host: args.hostId)
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

  private func metadata(_ record: SshKeyRecord) -> [String: Any] {
    ["id": record.id, "name": record.name, "algorithm": record.algorithm,
     "fingerprint": record.fingerprint, "publicKey": record.publicKey]
  }
}
