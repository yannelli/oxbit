import Foundation

private final class RefuseRedirects: NSObject, URLSessionTaskDelegate {
  func urlSession(_ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void) {
    completionHandler(nil)
  }
}

/// The ChatGPT credential in the agent Keychain service. Sign-in saves, refreshes and sign-out run on
/// this actor, and one refresh runs at a time; callers that need a refresh meanwhile await that one.
actor ChatGPTTokens {
  private let keys = AgentModelKeys()
  private let session: URLSession = {
    let config = URLSessionConfiguration.ephemeral
    config.httpShouldSetCookies = false
    config.httpCookieAcceptPolicy = .never
    config.urlCache = nil
    config.timeoutIntervalForRequest = 60
    return URLSession(configuration: config, delegate: RefuseRedirects(), delegateQueue: nil)
  }()
  private var refreshing: Task<ChatGPTAuth.Credential, Error>?
  /// Changes on sign-in and sign-out, so a refresh that started before either does not save.
  private var generation = 0

  func start() async throws -> ChatGPTAuth.DeviceCode {
    let (status, body) = try await send(ChatGPTAuth.startRequest())
    guard (200..<300).contains(status) else {
      throw AgentModelFailure(ChatGPTAuth.failure("ChatGPT sign-in", status: status, body: body))
    }
    return try ChatGPTAuth.deviceCode(body)
  }

  /// One device token poll. On `.complete` it exchanges the code and saves the credential.
  func poll(deviceAuthId: String, userCode: String, account: String) async throws -> String {
    let (status, body) = try await send(ChatGPTAuth.pollRequest(deviceAuthId: deviceAuthId, userCode: userCode))
    switch ChatGPTAuth.poll(status: status, body: body) {
    case .pending: return "pending"
    case .slowDown: return "slow_down"
    case .failed(let message): throw AgentModelFailure(message)
    case .complete(let code, let verifier):
      let credential = try await token(ChatGPTAuth.exchangeRequest(code: code, verifier: verifier), previous: nil)
      generation += 1
      try keys.save(try encode(credential), account: account)
      return "complete"
    }
  }

  func remove(_ account: String) throws {
    generation += 1
    try keys.delete(account)
  }

  /// The saved credential, refreshed first when it expires within the margin or when `rejected`
  /// is still its access token.
  func credential(_ account: String, rejected: String? = nil) async throws -> ChatGPTAuth.Credential {
    if let refreshing { return try await refreshing.value }
    let saved = try read(account)
    guard saved.access == rejected || ChatGPTAuth.needsRefresh(saved, now: Date()) else { return saved }
    let task = Task { try await self.refresh(saved, account: account) }
    refreshing = task
    defer { if refreshing == task { refreshing = nil } }
    return try await task.value
  }

  private func refresh(_ saved: ChatGPTAuth.Credential, account: String) async throws -> ChatGPTAuth.Credential {
    let started = generation
    let fresh = try await token(ChatGPTAuth.refreshRequest(saved.refresh), previous: saved)
    guard started == generation else { return try read(account) }
    try keys.save(try encode(fresh), account: account)
    return fresh
  }

  private func token(_ request: URLRequest, previous: ChatGPTAuth.Credential?) async throws -> ChatGPTAuth.Credential {
    let (status, body) = try await send(request)
    if previous != nil, status == 400 || status == 401 { throw ChatGPTSignInRequired() }
    guard (200..<300).contains(status) else {
      throw AgentModelFailure(ChatGPTAuth.failure("ChatGPT token request", status: status, body: body))
    }
    return try ChatGPTAuth.credential(body, previous: previous, now: Date())
  }

  private func read(_ account: String) throws -> ChatGPTAuth.Credential {
    guard let text = try keys.read(account),
      let credential = try? JSONDecoder().decode(ChatGPTAuth.Credential.self, from: Data(text.utf8))
    else { throw ChatGPTSignInRequired() }
    return credential
  }

  private func encode(_ credential: ChatGPTAuth.Credential) throws -> String {
    String(decoding: try JSONEncoder().encode(credential), as: UTF8.self)
  }

  private func send(_ request: URLRequest) async throws -> (Int, Data) {
    let (data, response) = try await session.data(for: request)
    return ((response as? HTTPURLResponse)?.statusCode ?? 0, data)
  }
}
