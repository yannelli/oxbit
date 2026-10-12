import Foundation

/// A missing, unreadable, or rejected ChatGPT sign-in. `AgentModels` rejects with code `MISSING_KEY`.
struct ChatGPTSignInRequired: LocalizedError {
  var errorDescription: String? { ChatGPTAuth.signInMessage }
}

/// The ChatGPT plan sign-in: the Codex CLI device code flow with its OAuth client, as in
/// openai/codex `codex-rs/login/src/device_code_auth.rs`.
enum ChatGPTAuth {
  static let clientId = "app_EMoamEEZ73f0CkXaXp7hrann"
  static let issuer = "https://auth.openai.com"
  static let verificationUrl = "\(issuer)/codex/device"
  static let codeLifetimeMs = 15 * 60 * 1000
  static let refreshMarginMs = 5 * 60 * 1000
  static let signInMessage = "Sign in with ChatGPT in Agent setup"
  private static let jwtClaim = "https://api.openai.com/auth"

  /// Saved as JSON in the agent Keychain service. `expiresAt` is epoch milliseconds.
  struct Credential: Codable, Equatable {
    var access: String
    var refresh: String
    var idToken: String
    var expiresAt: Int
    var accountId: String
  }

  struct DeviceCode: Equatable {
    let deviceAuthId: String
    let userCode: String
    /// Seconds between polls, at least 1.
    let interval: Int
  }

  enum Poll: Equatable {
    case pending
    case slowDown
    case complete(code: String, verifier: String)
    case failed(String)
  }

  static func milliseconds(_ date: Date) -> Int { Int((date.timeIntervalSince1970 * 1000).rounded()) }

  static func needsRefresh(_ credential: Credential, now: Date) -> Bool {
    credential.expiresAt - refreshMarginMs <= milliseconds(now)
  }

  static func deviceCode(_ body: Data) throws -> DeviceCode {
    let json = object(body)
    guard let id = nonEmpty(json?["device_auth_id"]), let code = nonEmpty(json?["user_code"] ?? json?["usercode"]) else {
      throw AgentModelFailure("The ChatGPT sign-in answered without a device code.")
    }
    let interval: Int?
    switch json?["interval"] {
    case let text as String: interval = Int(text.trimmingCharacters(in: .whitespaces))
    case let number as NSNumber: interval = number.intValue
    default: interval = 5
    }
    guard let interval else { throw AgentModelFailure("The ChatGPT sign-in answered with an invalid interval.") }
    return DeviceCode(deviceAuthId: id, userCode: code, interval: max(interval, 1))
  }

  /// Maps a device token poll answer. A 2xx body carries the authorization code and PKCE verifier.
  static func poll(status: Int, body: Data) -> Poll {
    let json = object(body)
    if (200..<300).contains(status) {
      guard let code = nonEmpty(json?["authorization_code"]), let verifier = nonEmpty(json?["code_verifier"]) else {
        return .failed("The ChatGPT sign-in answered without an authorization code.")
      }
      return .complete(code: code, verifier: verifier)
    }
    if status == 403 || status == 404 { return .pending }
    let error = json?["error"]
    switch (error as? String) ?? ((error as? [String: Any])?["code"] as? String) {
    case "deviceauth_authorization_pending": return .pending
    case "slow_down": return .slowDown
    default: return .failed(failure("ChatGPT sign-in", status: status, body: body))
    }
  }

  /// Reads an OAuth token answer. A refresh answer without a refresh or ID token keeps `previous`'s.
  static func credential(_ body: Data, previous: Credential?, now: Date) throws -> Credential {
    let json = object(body)
    guard let access = nonEmpty(json?["access_token"]),
      let refresh = nonEmpty(json?["refresh_token"]) ?? previous?.refresh
    else { throw AgentModelFailure("The ChatGPT token answer has no access or refresh token.") }
    let idToken = nonEmpty(json?["id_token"]) ?? previous?.idToken ?? ""
    guard let accountId = accountId(jwt: access) ?? accountId(jwt: idToken) ?? previous?.accountId else {
      throw AgentModelFailure("The ChatGPT sign-in has no ChatGPT account.")
    }
    let expiresAt: Int
    if let seconds = json?["expires_in"] as? NSNumber {
      expiresAt = milliseconds(now) + Int(seconds.doubleValue * 1000)
    } else {
      expiresAt = ((claims(access)?["exp"] as? NSNumber)?.intValue ?? 0) * 1000
    }
    return Credential(access: access, refresh: refresh, idToken: idToken, expiresAt: expiresAt, accountId: accountId)
  }

  static func accountId(jwt: String) -> String? {
    nonEmpty((claims(jwt)?[jwtClaim] as? [String: Any])?["chatgpt_account_id"])
  }

  static func startRequest() -> URLRequest {
    json("\(issuer)/api/accounts/deviceauth/usercode", ["client_id": clientId])
  }

  static func pollRequest(deviceAuthId: String, userCode: String) -> URLRequest {
    json("\(issuer)/api/accounts/deviceauth/token", ["device_auth_id": deviceAuthId, "user_code": userCode])
  }

  static func exchangeRequest(code: String, verifier: String) -> URLRequest {
    form([("grant_type", "authorization_code"), ("client_id", clientId), ("code", code),
      ("code_verifier", verifier), ("redirect_uri", "\(issuer)/deviceauth/callback")])
  }

  static func refreshRequest(_ refreshToken: String) -> URLRequest {
    form([("grant_type", "refresh_token"), ("refresh_token", refreshToken), ("client_id", clientId)])
  }

  static func failure(_ operation: String, status: Int, body: Data) -> String {
    let text = String(decoding: body.prefix(4096), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    return "\(operation) failed with status \(status)" + (text.isEmpty ? "" : ": \(text)")
  }

  private static func claims(_ jwt: String) -> [String: Any]? {
    let parts = jwt.split(separator: ".", omittingEmptySubsequences: false)
    guard parts.count == 3 else { return nil }
    var payload = parts[1].replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    payload += String(repeating: "=", count: (4 - payload.count % 4) % 4)
    return Data(base64Encoded: payload).flatMap(object)
  }

  private static func object(_ data: Data) -> [String: Any]? {
    (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
  }

  private static func nonEmpty(_ value: Any?) -> String? {
    (value as? String).flatMap { $0.isEmpty ? nil : $0 }
  }

  private static func json(_ url: String, _ fields: [String: String]) -> URLRequest {
    var request = URLRequest(url: URL(string: url)!)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try? JSONSerialization.data(withJSONObject: fields)
    return request
  }

  private static func form(_ fields: [(String, String)]) -> URLRequest {
    let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
    let encode = { (text: String) in text.addingPercentEncoding(withAllowedCharacters: allowed) ?? "" }
    var request = URLRequest(url: URL(string: "\(issuer)/oauth/token")!)
    request.httpMethod = "POST"
    request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
    request.httpBody = Data(fields.map { "\(encode($0.0))=\(encode($0.1))" }.joined(separator: "&").utf8)
    return request
  }
}
