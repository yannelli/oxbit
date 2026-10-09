import Foundation
import Security
import Tauri

private struct RuntimeCredentialArgs: Decodable {
  let operation: String
  let url: String
  let runtimeId: String?
  let code: String?
}

private struct PairResult: Encodable {
  let token: String
  let runtime: RuntimeIdentity?
}

/// Pair outside the WebView's cookie store and keep reconnect credentials in the device Keychain,
/// keyed by runtime id so a port change keeps the token. URL accounts move to the id on first use.
final class RuntimeCredentials: NSObject, URLSessionTaskDelegate {
  private let service = "com.yannelli.oxbit.runtime"
  private lazy var session: URLSession = {
    let config = URLSessionConfiguration.ephemeral
    config.httpShouldSetCookies = false
    config.timeoutIntervalForRequest = 15
    config.timeoutIntervalForResource = 20
    return URLSession(configuration: config, delegate: self, delegateQueue: nil)
  }()

  func handle(_ invoke: Invoke) {
    do {
      let args = try invoke.parseArgs(RuntimeCredentialArgs.self)
      guard let url = RuntimeAccount.origin(args.url) else {
        throw failure("Enter an http:// or https:// runtime address without a path or credentials.")
      }
      if let runtimeId = args.runtimeId, !RuntimeIdentity.validId(runtimeId) {
        throw failure("The runtime id is invalid.")
      }
      let account = RuntimeAccount.url(url)
      let idAccount = args.runtimeId.map(RuntimeAccount.id)
      switch args.operation {
      case "get":
        invoke.resolve(try get(idAccount: idAccount, urlAccount: account).map { ["token": $0] } ?? [:])
      case "forget":
        if let idAccount { try delete(idAccount) }
        try delete(account)
        invoke.resolve([String: String]())
      case "health":
        health(url, invoke)
      case "pair":
        guard let code = args.code?.trimmingCharacters(in: .whitespacesAndNewlines), !code.isEmpty else {
          throw failure("Enter the pairing code shown by your runtime.")
        }
        if code.hasPrefix("grant:") {
          let token = String(code.dropFirst(6))
          guard !token.isEmpty else { throw failure("The runtime grant is empty.") }
          try save(token, account: idAccount ?? account)
          invoke.resolve(["token": token])
          return
        }
        pair(url, code: code, urlAccount: account, invoke)
      default:
        throw failure("Unknown runtime credential operation.")
      }
    } catch {
      invoke.reject(error.localizedDescription, code: "RUNTIME_CREDENTIALS")
    }
  }

  private func get(idAccount: String?, urlAccount: String) throws -> String? {
    guard let idAccount else { return try read(urlAccount) }
    if let token = try read(idAccount) { return token }
    guard let token = try read(urlAccount) else { return nil }
    try save(token, account: idAccount)
    try delete(urlAccount)
    return token
  }

  private func pair(_ url: URL, code: String, urlAccount: String, _ invoke: Invoke) {
    var request = URLRequest(url: url.appendingPathComponent("api/pair"))
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    do {
      request.httpBody = try JSONSerialization.data(withJSONObject: ["code": code])
    } catch {
      invoke.reject(error.localizedDescription, code: "RUNTIME_PAIRING")
      return
    }
    session.dataTask(with: request) { data, response, error in
      do {
        let json = try self.json(data, response, error, fallback: "Pairing failed") {
          "Pairing failed (HTTP \($0)). Check the address and pairing code."
        }
        guard let token = json["token"] as? String, !token.isEmpty else {
          throw self.failure("The runtime did not return a pairing token.")
        }
        let runtime = RuntimeIdentity(json: json["runtime"])
        if let runtime {
          try self.save(token, account: RuntimeAccount.id(runtime.id))
          try self.delete(urlAccount)
        } else {
          try self.save(token, account: urlAccount)
        }
        invoke.resolve(PairResult(token: token, runtime: runtime))
      } catch {
        invoke.reject(error.localizedDescription, code: "RUNTIME_PAIRING")
      }
    }.resume()
  }

  /// The WebView cannot read `/api/health` across origins, so the identity check runs here.
  private func health(_ url: URL, _ invoke: Invoke) {
    let request = URLRequest(url: url.appendingPathComponent("api/health"), timeoutInterval: 5)
    session.dataTask(with: request) { data, response, error in
      do {
        let json = try self.json(data, response, error, fallback: "The runtime is unreachable") {
          "The runtime health check failed (HTTP \($0))."
        }
        guard json["protocol"] as? Int == 1, let runtime = RuntimeIdentity(json: json) else {
          throw self.failure("The runtime did not report its identity. Update Oxbit on that computer.")
        }
        invoke.resolve(["runtime": runtime])
      } catch {
        invoke.reject(error.localizedDescription, code: "RUNTIME_HEALTH")
      }
    }.resume()
  }

  private func json(_ data: Data?, _ response: URLResponse?, _ error: Error?, fallback: String,
    status: (Int) -> String) throws -> [String: Any] {
    if let error {
      throw failure("\(fallback): \(error.localizedDescription)")
    }
    guard let response = response as? HTTPURLResponse, let data, data.count <= 1_048_576 else {
      throw failure("The runtime returned an invalid response.")
    }
    let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    guard (200..<300).contains(response.statusCode) else {
      let message = (json?["error"] as? [String: Any])?["message"] as? String
        ?? json?["error"] as? String
        ?? status(response.statusCode)
      throw failure(message)
    }
    guard let json else { throw failure("The runtime returned an invalid response.") }
    return json
  }

  // A redirect must never forward an owner pairing code to a different endpoint.
  func urlSession(_ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void) {
    completionHandler(nil)
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
    guard let data = result as? Data, let token = String(data: data, encoding: .utf8) else {
      throw failure("The saved runtime credential could not be read. Pair again.")
    }
    return token
  }

  private func delete(_ account: String) throws {
    let status = SecItemDelete(query(account) as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else { throw keychainError(status) }
  }

  private func save(_ token: String, account: String) throws {
    let values: [String: Any] = [kSecValueData as String: Data(token.utf8),
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
    let existing = query(account)
    var status = SecItemUpdate(existing as CFDictionary, values as CFDictionary)
    if status == errSecItemNotFound {
      status = SecItemAdd(existing.merging(values) { _, value in value } as CFDictionary, nil)
    }
    guard status == errSecSuccess else { throw keychainError(status) }
  }

  private func failure(_ message: String) -> NSError {
    NSError(domain: "OxbitRuntime", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
  }

  private func keychainError(_ status: OSStatus) -> NSError {
    failure("Could not access the saved runtime credential: \(SecCopyErrorMessageString(status, nil) as String? ?? String(status))")
  }
}
