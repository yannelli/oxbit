import Foundation
import Security

func expect(_ value: @autoclosure () throws -> Bool, _ message: String) throws {
  guard try value() else {
    throw NSError(domain: "SshKeyStoreTests", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
  }
}

func rejects(_ operation: () throws -> Void) -> Bool {
  do { try operation() } catch { return (error as NSError).domain == "OxbitSshKeys" }
  return false
}

func record(_ id: String, name: String) throws -> SshKeyRecord {
  try SshKeyStore.validated(id: id, name: name, algorithm: "ssh-ed25519",
    fingerprint: "SHA256:harness\(name)", publicKey: "ssh-ed25519 AAAAharness \(name)@oxbit-ios",
    privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\n\(name)\n-----END OPENSSH PRIVATE KEY-----\n")
}

func runTests(_ store: SshKeyStore, first: String, second: String, host: String) throws {
  try expect(try store.keys().isEmpty, "a new service lists no keys")
  try expect(rejects { _ = try SshKeyStore.validated(id: first, name: "Bad", algorithm: "ssh-ed25519",
    fingerprint: "MD5:00", publicKey: "ssh-ed25519 AAAA", privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----") },
    "a fingerprint without SHA256: is refused")
  try expect(rejects { try store.deleteKey("not-a-uuid") }, "a non-UUID id is refused")

  try store.save(try record(first, name: "Laptop"))
  Thread.sleep(forTimeInterval: 0.01)
  try store.save(try record(second, name: "Phone"))
  try expect(try store.keys().map(\.name) == ["Laptop", "Phone"], "list returns both keys in creation order")
  try expect(try store.key(second)?.privateKey.contains("\nPhone\n") == true, "read returns the stored private key")

  try store.save(try record(second, name: "Tablet"))
  try expect(try store.keys().map(\.name) == ["Laptop", "Tablet"], "saving an existing id updates it in place")

  try store.deleteKey(first)
  try expect(try store.keys().map(\.id) == [second], "delete removes only that key")
  try expect(try store.key(first) == nil, "a deleted key no longer reads")
  try store.deleteKey(first)

  try expect(try store.password(host: host) == nil, "no password before saving")
  try store.savePassword("correct horse", host: host)
  try store.savePassword("battery staple", host: host)
  try expect(try store.password(host: host) == "battery staple", "the second password replaces the first")
  try expect(rejects { try store.savePassword(String(repeating: "x", count: 1_025), host: host) },
    "a password over 1024 bytes is refused")
  try store.forgetPassword(host: host)
  try expect(try store.password(host: host) == nil, "forget removes the password")
}

let suffix = UUID().uuidString
let store = SshKeyStore(keyService: "com.yannelli.oxbit.ssh-key.test-\(suffix)",
  passwordService: "com.yannelli.oxbit.ssh-password.test-\(suffix)")
let first = UUID().uuidString, second = UUID().uuidString, host = UUID().uuidString

/// A locked login keychain answers reads with errSecItemNotFound, so the first call is a write.
let probe: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
  kSecAttrService as String: store.keyService, kSecAttrAccount as String: "probe"]
let probed = SecItemAdd(probe.merging([kSecValueData as String: Data()]) { $1 } as CFDictionary, nil)
if probed == errSecInteractionNotAllowed {
  print("SshKeyStore tests skipped: the login keychain is locked in this session")
  exit(0)
}
SecItemDelete(probe as CFDictionary)
guard probed == errSecSuccess else {
  FileHandle.standardError.write(Data("SshKeyStore Keychain tests failed: SecItemAdd returned \(probed)\n".utf8))
  exit(1)
}
do {
  defer {
    try? store.deleteKey(first)
    try? store.deleteKey(second)
    try? store.forgetPassword(host: host)
  }
  try runTests(store, first: first, second: second, host: host)
  print("SshKeyStore Keychain tests passed")
} catch {
  FileHandle.standardError.write(Data("SshKeyStore Keychain tests failed: \(error.localizedDescription)\n".utf8))
  exit(1)
}
