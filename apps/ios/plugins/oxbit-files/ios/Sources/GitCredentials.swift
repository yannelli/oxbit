import Foundation
import Security
import Tauri

private struct GitCredentialArgs: Decodable {
  let operation: String
  let token: String?
  let name: String?
  let email: String?
  let url: String?
}

private struct GiteaCredentialProfile: Codable {
  var url: String
  var host: String
  var token: String
  var login: String
}

private struct GitCredentialProfile: Codable {
  var token: String?
  var login: String?
  var name: String?
  var email: String?
  var gitea: GiteaCredentialProfile?
}

private struct GiteaServer {
  let url: String
  let host: String
  let user: URL
}

private func gitCredentialFailure(_ message: String) -> NSError {
  NSError(domain: "OxbitGitCredentials", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
}

final class GitCredentials {
  private let queue = DispatchQueue(label: "com.yannelli.oxbit.git-credentials")
  private var verifying = false

  func handle(_ invoke: Invoke) {
    let args: GitCredentialArgs
    do {
      args = try invoke.parseArgs(GitCredentialArgs.self)
    } catch {
      invoke.reject("Invalid Git credential request.", code: "GIT_CREDENTIALS")
      return
    }
    queue.async { self.process(args, invoke: invoke) }
  }

  private func process(_ args: GitCredentialArgs, invoke: Invoke) {
    do {
      switch args.operation {
      case "get":
        invoke.resolve(metadata(try read()))
      case "read":
        invoke.resolve(credentials(try read()))
      case "forget":
        guard !verifying else { throw gitCredentialFailure("Git credentials are being verified. Try again when validation finishes.") }
        var profile = try read()
        profile.token = nil
        profile.login = nil
        try save(profile)
        invoke.resolve(metadata(profile))
      case "save":
        guard !verifying else { throw gitCredentialFailure("Git credentials are being verified. Try again when validation finishes.") }
        let name = try identity(args.name, field: "name", limit: 256)
        let email = try identity(args.email, field: "email", limit: 320)
        var profile = try read()
        profile.name = name
        profile.email = email
        let token = try normalizedToken(args.token)
        guard let token else {
          try save(profile)
          invoke.resolve(metadata(profile))
          return
        }
        let pendingProfile = profile
        verifying = true
        AccountValidation.gitHub(token: token) { result in
          self.queue.async {
            self.verifying = false
            do {
              var verifiedProfile = pendingProfile
              verifiedProfile.login = try result.get()
              verifiedProfile.token = token
              try self.save(verifiedProfile)
              invoke.resolve(self.metadata(verifiedProfile))
            } catch {
              self.reject(error, invoke: invoke)
            }
          }
        }.start()
      case "connectGitea":
        guard !verifying else { throw gitCredentialFailure("Git credentials are being verified. Try again when validation finishes.") }
        let server = try giteaServer(args.url)
        guard let token = try normalizedToken(args.token, provider: "Gitea") else {
          throw gitCredentialFailure("Enter a Gitea access token.")
        }
        verifying = true
        AccountValidation.gitea(server: server, token: token) { result in
          self.queue.async {
            self.verifying = false
            do {
              let login = try result.get()
              var profile = try self.read()
              profile.gitea = GiteaCredentialProfile(url: server.url, host: server.host, token: token, login: login)
              try self.save(profile)
              invoke.resolve(self.metadata(profile))
            } catch {
              self.reject(error, invoke: invoke)
            }
          }
        }.start()
      case "forgetGitea":
        guard !verifying else { throw gitCredentialFailure("Git credentials are being verified. Try again when validation finishes.") }
        var profile = try read()
        profile.gitea = nil
        try save(profile)
        invoke.resolve(metadata(profile))
      default:
        throw gitCredentialFailure("Unknown Git credential operation.")
      }
    } catch {
      reject(error, invoke: invoke)
    }
  }

  private func identity(_ value: String?, field: String, limit: Int) throws -> String {
    guard let value, value.utf8.count <= limit * 4, value.count <= limit,
      value.rangeOfCharacter(from: .controlCharacters) == nil,
      !value.contains("<"), !value.contains(">")
    else { throw gitCredentialFailure("Enter a valid Git author \(field).") }
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { throw gitCredentialFailure("Enter a Git author \(field).") }
    if field == "email" {
      guard trimmed.range(of: "^[^\\s<>@]+@[^\\s<>@.]+(?:\\.[^\\s<>@.]+)+$", options: .regularExpression) != nil else {
        throw gitCredentialFailure("Enter a valid Git author email address.")
      }
    }
    return trimmed
  }

  private func normalizedToken(_ value: String?, provider: String = "GitHub") throws -> String? {
    guard let value else { return nil }
    guard value.utf8.count <= 4_096 else { throw gitCredentialFailure("The \(provider) token is too long.") }
    let token = value.trimmingCharacters(in: .whitespacesAndNewlines)
    if token.isEmpty { return nil }
    guard token.utf8.allSatisfy({ $0 >= 33 && $0 <= 126 }) else {
      throw gitCredentialFailure("Enter a valid \(provider) token.")
    }
    return token
  }

  /// Accepts an HTTPS server URL, optionally with a sub-path, and returns its
  /// canonical base URL and the `host[:port]` authority that Git credentials are bound to.
  private func giteaServer(_ value: String?) throws -> GiteaServer {
    let invalid = gitCredentialFailure("Enter the HTTPS address of your Gitea server.")
    guard let value, value.utf8.count <= 2_048 else { throw invalid }
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let components = URLComponents(string: trimmed),
      components.scheme?.lowercased() == "https",
      components.user == nil, components.password == nil,
      components.query == nil, components.fragment == nil,
      let host = components.host?.lowercased(), !host.isEmpty,
      host.utf8.allSatisfy({ ($0 >= 48 && $0 <= 57) || ($0 >= 97 && $0 <= 122) || $0 == 45 || $0 == 46 }),
      !host.hasPrefix("."), !host.hasSuffix("."), !host.hasPrefix("-")
    else { throw invalid }
    guard host != "github.com" else {
      throw gitCredentialFailure("Connect GitHub with a GitHub token instead.")
    }
    let path = components.percentEncodedPath.hasSuffix("/")
      ? String(components.percentEncodedPath.dropLast()) : components.percentEncodedPath
    guard path.isEmpty || path.hasPrefix("/"), !path.contains("//"),
      path.utf8.allSatisfy({ ($0 >= 48 && $0 <= 57) || ($0 >= 65 && $0 <= 90) || ($0 >= 97 && $0 <= 122) || $0 == 45 || $0 == 46 || $0 == 47 || $0 == 95 || $0 == 126 }),
      !path.split(separator: "/").contains(where: { $0 == "." || $0 == ".." })
    else { throw invalid }
    var authority = host
    if let port = components.port, port != 443 {
      guard (1...65_535).contains(port) else { throw invalid }
      authority += ":\(port)"
    }
    let url = "https://\(authority)\(path)"
    guard let user = URL(string: "\(url)/api/v1/user") else { throw invalid }
    return GiteaServer(url: url, host: authority, user: user)
  }

  private func metadata(_ profile: GitCredentialProfile) -> [String: Any] {
    var result: [String: Any] = ["authenticated": profile.token != nil && profile.login != nil]
    if let login = profile.login { result["login"] = login }
    if let name = profile.name { result["name"] = name }
    if let email = profile.email { result["email"] = email }
    if let gitea = profile.gitea {
      result["gitea"] = ["authenticated": true, "url": gitea.url, "host": gitea.host, "login": gitea.login] as [String: Any]
    }
    return result
  }

  private func credentials(_ profile: GitCredentialProfile) -> [String: Any] {
    var result: [String: Any] = [:]
    if let token = profile.token { result["token"] = token }
    if let login = profile.login { result["login"] = login }
    if let name = profile.name { result["name"] = name }
    if let email = profile.email { result["email"] = email }
    if let gitea = profile.gitea {
      result["gitea"] = ["url": gitea.url, "host": gitea.host, "login": gitea.login, "token": gitea.token] as [String: Any]
    }
    return result
  }

  private func query() -> [String: Any] {
    [kSecClass as String: kSecClassGenericPassword,
     kSecAttrService as String: "com.yannelli.oxbit.git",
     kSecAttrAccount as String: "github.com"]
  }

  private func read() throws -> GitCredentialProfile {
    var attributes = query()
    attributes[kSecReturnData as String] = true
    attributes[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(attributes as CFDictionary, &result)
    if status == errSecItemNotFound { return GitCredentialProfile() }
    guard status == errSecSuccess else { throw gitCredentialFailure("Could not access saved Git credentials on this device.") }
    guard let data = result as? Data, data.count <= 8_192,
      let profile = try? JSONDecoder().decode(GitCredentialProfile.self, from: data),
      (profile.token == nil) == (profile.login == nil)
    else { throw gitCredentialFailure("The saved Git credentials could not be read.") }
    if let token = profile.token {
      guard try normalizedToken(token) == token else { throw gitCredentialFailure("The saved GitHub token could not be read.") }
    }
    if let login = profile.login {
      guard AccountValidation.validGitHubLogin(login) else { throw gitCredentialFailure("The saved GitHub account could not be read.") }
    }
    if let gitea = profile.gitea {
      let server = try? giteaServer(gitea.url)
      guard server?.url == gitea.url, server?.host == gitea.host,
        try normalizedToken(gitea.token, provider: "Gitea") == gitea.token,
        AccountValidation.validGiteaLogin(gitea.login)
      else { throw gitCredentialFailure("The saved Gitea account could not be read.") }
    }
    if let name = profile.name { _ = try identity(name, field: "name", limit: 256) }
    if let email = profile.email { _ = try identity(email, field: "email", limit: 320) }
    return profile
  }

  private func save(_ profile: GitCredentialProfile) throws {
    let data = try JSONEncoder().encode(profile)
    guard data.count <= 8_192 else { throw gitCredentialFailure("The Git credentials are too large to save.") }
    let values: [String: Any] = [kSecValueData as String: data,
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
    let existing = query()
    var status = SecItemUpdate(existing as CFDictionary, values as CFDictionary)
    if status == errSecItemNotFound {
      status = SecItemAdd(existing.merging(values) { _, value in value } as CFDictionary, nil)
    }
    guard status == errSecSuccess else { throw gitCredentialFailure("Could not save Git credentials on this device.") }
  }

  private func reject(_ error: Error, invoke: Invoke) {
    let message = (error as NSError).domain == "OxbitGitCredentials"
      ? error.localizedDescription : "The Git credential request failed."
    invoke.reject(message, code: "GIT_CREDENTIALS")
  }
}

private struct CredentialUser: Decodable {
  let login: String
  let id: Int64
}

private final class AccountValidation: NSObject, URLSessionDataDelegate {
  private let provider: String
  private let endpoint: URL
  private let headers: [String: String]
  private let validLogin: (String) -> Bool
  private var session: URLSession?
  private var completion: ((Result<String, Error>) -> Void)?
  private var data = Data()
  private let maximumResponseBytes = 65_536

  private init(provider: String, endpoint: URL, headers: [String: String], validLogin: @escaping (String) -> Bool,
    completion: @escaping (Result<String, Error>) -> Void) {
    self.provider = provider
    self.endpoint = endpoint
    self.headers = headers
    self.validLogin = validLogin
    self.completion = completion
  }

  static func gitHub(token: String, completion: @escaping (Result<String, Error>) -> Void) -> AccountValidation {
    AccountValidation(provider: "GitHub", endpoint: URL(string: "https://api.github.com/user")!,
      headers: ["Accept": "application/vnd.github+json", "Authorization": "Bearer \(token)",
        "X-GitHub-Api-Version": "2022-11-28"],
      validLogin: validGitHubLogin, completion: completion)
  }

  static func gitea(server: GiteaServer, token: String, completion: @escaping (Result<String, Error>) -> Void) -> AccountValidation {
    AccountValidation(provider: "Gitea", endpoint: server.user,
      headers: ["Accept": "application/json", "Authorization": "token \(token)"],
      validLogin: validGiteaLogin, completion: completion)
  }

  func start() {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.httpShouldSetCookies = false
    configuration.httpCookieStorage = nil
    configuration.urlCredentialStorage = nil
    configuration.urlCache = nil
    configuration.timeoutIntervalForRequest = 15
    configuration.timeoutIntervalForResource = 20
    let delegateQueue = OperationQueue()
    delegateQueue.maxConcurrentOperationCount = 1
    let session = URLSession(configuration: configuration, delegate: self, delegateQueue: delegateQueue)
    self.session = session
    var request = URLRequest(url: endpoint)
    request.httpMethod = "GET"
    for (field, value) in headers { request.setValue(value, forHTTPHeaderField: field) }
    request.setValue("Oxbit-iOS", forHTTPHeaderField: "User-Agent")
    session.dataTask(with: request).resume()
  }

  static func validGitHubLogin(_ login: String) -> Bool {
    !login.isEmpty && login.utf8.count <= 256
      && login.utf8.allSatisfy({ ($0 >= 48 && $0 <= 57) || ($0 >= 65 && $0 <= 90) || ($0 >= 97 && $0 <= 122) || $0 == 45 })
  }

  static func validGiteaLogin(_ login: String) -> Bool {
    !login.isEmpty && login.utf8.count <= 256
      && login.utf8.allSatisfy({ ($0 >= 48 && $0 <= 57) || ($0 >= 65 && $0 <= 90) || ($0 >= 97 && $0 <= 122) || $0 == 45 || $0 == 46 || $0 == 95 })
  }

  func urlSession(_ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void) {
    completionHandler(nil)
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask,
    didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
    guard let response = response as? HTTPURLResponse, response.url == endpoint,
      response.expectedContentLength <= Int64(maximumResponseBytes)
    else {
      completionHandler(.cancel)
      finish(.failure(gitCredentialFailure("\(provider) returned an invalid token validation response.")))
      return
    }
    guard response.statusCode == 200 else {
      completionHandler(.cancel)
      let message = response.statusCode == 401 || response.statusCode == 403
        ? "\(provider) rejected this token or its permissions."
        : "\(provider) token validation failed (HTTP \(response.statusCode))."
      finish(.failure(gitCredentialFailure(message)))
      return
    }
    completionHandler(.allow)
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive chunk: Data) {
    guard completion != nil else { return }
    guard chunk.count <= maximumResponseBytes - data.count else {
      finish(.failure(gitCredentialFailure("\(provider) returned an oversized token validation response.")))
      return
    }
    data.append(chunk)
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    guard completion != nil else { return }
    guard error == nil else {
      finish(.failure(gitCredentialFailure("Could not validate the \(provider) token. Check your connection and try again.")))
      return
    }
    guard let user = try? JSONDecoder().decode(CredentialUser.self, from: data),
      user.id > 0, validLogin(user.login)
    else {
      finish(.failure(gitCredentialFailure("\(provider) returned an invalid account response.")))
      return
    }
    finish(.success(user.login))
  }

  private func finish(_ result: Result<String, Error>) {
    guard let completion else { return }
    self.completion = nil
    session?.invalidateAndCancel()
    session = nil
    data.removeAll()
    completion(result)
  }
}
