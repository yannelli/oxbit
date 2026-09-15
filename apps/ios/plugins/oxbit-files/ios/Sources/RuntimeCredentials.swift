import Foundation
import Security
import Tauri

private struct RuntimeCredentialArgs: Decodable {
  let operation: String
  let url: String
  let code: String?
}

/// Pair outside the WebView's cookie store and keep reconnect credentials in the device Keychain.
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
      guard let components = URLComponents(string: args.url),
        ["http", "https"].contains(components.scheme ?? ""),
        let host = components.host, !host.isEmpty,
        components.user == nil, components.password == nil,
        components.query == nil, components.fragment == nil,
        components.path.isEmpty || components.path == "/",
        let url = components.url
      else { throw failure("Enter an http:// or https:// runtime address without a path or credentials.") }
      let account = url.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
      switch args.operation {
      case "get":
        invoke.resolve(try read(account).map { ["token": $0] } ?? [:])
      case "forget":
        let status = SecItemDelete(query(account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw keychainError(status) }
        invoke.resolve([String: String]())
      case "pair":
        guard let code = args.code?.trimmingCharacters(in: .whitespacesAndNewlines), !code.isEmpty else {
          throw failure("Enter the pairing code shown by your runtime.")
        }
        if code.hasPrefix("grant:") {
          let token = String(code.dropFirst(6))
          guard !token.isEmpty else { throw failure("The runtime grant is empty.") }
          try save(token, account: account)
          invoke.resolve(["token": token])
          return
        }
        var request = URLRequest(url: url.appendingPathComponent("api/pair"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["code": code])
        session.dataTask(with: request) { data, response, error in
          do {
            if let error { throw error }
            guard let response = response as? HTTPURLResponse, let data, data.count <= 1_048_576 else {
              throw self.failure("The runtime returned an invalid pairing response.")
            }
            let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            guard (200..<300).contains(response.statusCode) else {
              let message = (json?["error"] as? [String: Any])?["message"] as? String
                ?? json?["error"] as? String
                ?? "Pairing failed (HTTP \(response.statusCode)). Check the address and pairing code."
              throw self.failure(message)
            }
            guard let token = json?["token"] as? String, !token.isEmpty else {
              throw self.failure("The runtime did not return a pairing token.")
            }
            try self.save(token, account: account)
            invoke.resolve(["token": token])
          } catch {
            invoke.reject(error.localizedDescription, code: "RUNTIME_PAIRING")
          }
        }.resume()
      default:
        throw failure("Unknown runtime credential operation.")
      }
    } catch {
      invoke.reject(error.localizedDescription, code: "RUNTIME_CREDENTIALS")
    }
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
