import Foundation
import Security

struct AgentModelFailure: LocalizedError {
  let message: String
  init(_ message: String) { self.message = message }
  var errorDescription: String? { message }
}

/// A model API base. `openai` and `anthropic` have fixed origins; `openai-compatible` uses the
/// user's https base URL. Requests stay on the base's origin and under its path prefix.
struct AgentModelEndpoint {
  static let anthropicVersion = "2023-06-01"

  let api: String
  private let base: URLComponents

  init(api: String, baseUrl: String?) throws {
    self.api = api
    switch api {
    case "openai":
      base = URLComponents(string: "https://api.openai.com")!
    case "anthropic":
      base = URLComponents(string: "https://api.anthropic.com")!
    case "openai-compatible":
      let text = baseUrl?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
      guard var components = URLComponents(string: text), components.scheme?.lowercased() == "https",
        let host = components.percentEncodedHost, !host.isEmpty, components.user == nil,
        components.password == nil, components.query == nil, components.fragment == nil
      else {
        throw AgentModelFailure("Enter an https:// base URL without credentials, a query, or a fragment.")
      }
      let prefix = components.percentEncodedPath
      guard !prefix.contains(".."), !prefix.lowercased().contains("%2e") else {
        throw AgentModelFailure("The base URL path cannot contain \"..\".")
      }
      components.scheme = "https"
      components.percentEncodedHost = host.lowercased()
      if components.port == 443 { components.port = nil }
      while components.percentEncodedPath.hasSuffix("/") { components.percentEncodedPath.removeLast() }
      base = components
    default:
      throw AgentModelFailure("Unknown model API \(api).")
    }
  }

  var origin: String {
    var origin = base
    origin.percentEncodedPath = ""
    return origin.string ?? ""
  }

  /// Keychain account: the API and the origin, so a changed path prefix keeps the key.
  var account: String { "\(api) \(origin)" }

  func url(_ path: String) throws -> URL {
    let invalid = CharacterSet.whitespacesAndNewlines.union(.controlCharacters)
    guard path.hasPrefix("/"), !path.hasPrefix("//"), !path.contains(".."), !path.contains("\\"),
      !path.contains("#"), !path.lowercased().contains("%2e"), path.rangeOfCharacter(from: invalid) == nil,
      let url = URL(string: (base.string ?? "") + path),
      let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
      components.scheme == "https", components.percentEncodedHost?.lowercased() == base.percentEncodedHost,
      components.port == base.port,
      components.user == nil, components.password == nil, components.fragment == nil,
      components.percentEncodedPath.hasPrefix(base.percentEncodedPath + "/")
    else {
      throw AgentModelFailure("The model API path \(path) is not allowed.")
    }
    return url
  }

  func authorize(_ request: inout URLRequest, key: String) {
    if api == "anthropic" {
      request.setValue(key, forHTTPHeaderField: "x-api-key")
      request.setValue(AgentModelEndpoint.anthropicVersion, forHTTPHeaderField: "anthropic-version")
    } else {
      request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
    }
  }
}

/// API keys in the device Keychain under one service, one item per `AgentModelEndpoint.account`.
struct AgentModelKeys {
  private let service = "com.yannelli.oxbit.agent"

  private func query(_ account: String) -> [String: Any] {
    [kSecClass as String: kSecClassGenericPassword,
     kSecAttrService as String: service, kSecAttrAccount as String: account]
  }

  func read(_ account: String) throws -> String? {
    var attributes = query(account)
    attributes[kSecReturnData as String] = true
    attributes[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(attributes as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess else { throw keychainError(status) }
    guard let data = result as? Data, let key = String(data: data, encoding: .utf8) else {
      throw AgentModelFailure("The saved API key could not be read. Add it again in Agent setup.")
    }
    return key
  }

  func save(_ key: String, account: String) throws {
    let values: [String: Any] = [kSecValueData as String: Data(key.utf8),
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
    let existing = query(account)
    var status = SecItemUpdate(existing as CFDictionary, values as CFDictionary)
    if status == errSecItemNotFound {
      status = SecItemAdd(existing.merging(values) { _, value in value } as CFDictionary, nil)
    }
    guard status == errSecSuccess else { throw keychainError(status) }
  }

  func delete(_ account: String) throws {
    let status = SecItemDelete(query(account) as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else { throw keychainError(status) }
  }

  private func keychainError(_ status: OSStatus) -> AgentModelFailure {
    AgentModelFailure("Could not access the saved API key: \(SecCopyErrorMessageString(status, nil) as String? ?? String(status))")
  }
}
