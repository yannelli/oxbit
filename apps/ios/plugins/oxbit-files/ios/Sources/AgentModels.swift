import Foundation
import Tauri

private struct AgentModelStreamArgs: Decodable {
  let id: String
  let api: String
  let baseUrl: String?
  let method: String
  let path: String
  let body: String?
  let channel: Channel
}

private struct AgentModelCancelArgs: Decodable {
  let id: String
}

private struct AgentModelKeyArgs: Decodable {
  let operation: String
  let api: String
  let baseUrl: String?
  let key: String?
}

private struct AgentModelChatGPTArgs: Decodable {
  let operation: String
  let deviceAuthId: String?
  let userCode: String?
}

/// A ChatGPT request without its authorization, and the access token it was sent with.
private struct ChatGPTRetry {
  let request: URLRequest
  let account: String
  let access: String
}

/// Model API requests for the in-app agent, authorized with the endpoint's Keychain key in Swift.
/// A request sends base64 `chunk` events, then `end` with the status (body for non-2xx) or `failed`.
final class AgentModels: NSObject, URLSessionDataDelegate {
  private final class Stream {
    let id: String
    let channel: Channel
    var status = 0
    var body = Data()
    var cancelled = false
    var truncated = false
    var retry: ChatGPTRetry?

    init(id: String, channel: Channel, retry: ChatGPTRetry?) {
      self.id = id
      self.channel = channel
      self.retry = retry
    }
  }

  private static let errorBodyLimit = 65_536
  private let keys = AgentModelKeys()
  private let chatgptTokens = ChatGPTTokens()
  // Serial delegate queue; `streams` and `tasks` change only on it.
  private let queue: OperationQueue = {
    let queue = OperationQueue()
    queue.maxConcurrentOperationCount = 1
    return queue
  }()
  private lazy var session: URLSession = {
    let config = URLSessionConfiguration.ephemeral
    config.httpShouldSetCookies = false
    config.httpCookieAcceptPolicy = .never
    config.urlCache = nil
    config.requestCachePolicy = .reloadIgnoringLocalCacheData
    config.timeoutIntervalForRequest = 300
    config.timeoutIntervalForResource = 3600
    return URLSession(configuration: config, delegate: self, delegateQueue: queue)
  }()
  private var streams: [Int: Stream] = [:]
  private var tasks: [String: URLSessionDataTask] = [:]
  /// ChatGPT streams waiting for the forced refresh after a 401, by request id.
  private var refreshing: [String: Stream] = [:]

  func stream(_ invoke: Invoke) {
    let args: AgentModelStreamArgs
    let endpoint: AgentModelEndpoint
    var request: URLRequest
    do {
      args = try invoke.parseArgs(AgentModelStreamArgs.self)
      guard args.method == "GET" || args.method == "POST" else {
        throw AgentModelFailure("Unsupported model API method \(args.method).")
      }
      endpoint = try AgentModelEndpoint(api: args.api, baseUrl: args.baseUrl)
      request = URLRequest(url: try endpoint.url(args.path))
    } catch {
      invoke.reject(error.localizedDescription, code: "AGENT_MODELS")
      return
    }
    request.httpMethod = args.method
    if args.method == "POST" {
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = Data((args.body ?? "{}").utf8)
    }
    if endpoint.api == "chatgpt" {
      Task {
        do {
          let credential = try await chatgptTokens.credential(endpoint.account)
          var authorized = request
          AgentModelEndpoint.authorize(&authorized, chatgpt: credential)
          start(authorized, args, invoke,
            retry: ChatGPTRetry(request: request, account: endpoint.account, access: credential.access))
        } catch {
          reject(invoke, error, code: "AGENT_MODELS")
        }
      }
      return
    }
    do {
      if let key = try keys.read(endpoint.account) {
        endpoint.authorize(&request, key: key)
      } else if !endpoint.isLocalHttp {
        invoke.reject("Add an API key in Agent setup", code: "MISSING_KEY")
        return
      }
    } catch {
      invoke.reject(error.localizedDescription, code: "AGENT_MODELS")
      return
    }
    start(request, args, invoke, retry: nil)
  }

  private func start(_ request: URLRequest, _ args: AgentModelStreamArgs, _ invoke: Invoke, retry: ChatGPTRetry?) {
    queue.addOperation {
      guard self.tasks[args.id] == nil, self.refreshing[args.id] == nil else {
        invoke.reject("A model request with this id is running", code: "AGENT_MODELS")
        return
      }
      let task = self.session.dataTask(with: request)
      self.streams[task.taskIdentifier] = Stream(id: args.id, channel: args.channel, retry: retry)
      self.tasks[args.id] = task
      task.resume()
      invoke.resolve()
    }
  }

  private func reject(_ invoke: Invoke, _ error: Error, code: String) {
    if error is ChatGPTSignInRequired {
      invoke.reject(ChatGPTAuth.signInMessage, code: "MISSING_KEY")
    } else {
      invoke.reject(error.localizedDescription, code: code)
    }
  }

  /// Refreshes the token a 401 rejected and sends the request again, or ends with that 401.
  private func resend(_ id: String, _ retry: ChatGPTRetry) async {
    let credential = try? await chatgptTokens.credential(retry.account, rejected: retry.access)
    queue.addOperation {
      guard let stream = self.refreshing.removeValue(forKey: id) else { return }
      guard let credential else {
        self.finish(stream, error: nil)
        return
      }
      var request = retry.request
      AgentModelEndpoint.authorize(&request, chatgpt: credential)
      stream.status = 0
      stream.body = Data()
      stream.truncated = false
      let task = self.session.dataTask(with: request)
      self.streams[task.taskIdentifier] = stream
      self.tasks[id] = task
      task.resume()
    }
  }

  /// Resolves for unknown ids too, since a request can finish while its cancel is in flight.
  func cancel(_ invoke: Invoke) {
    let args: AgentModelCancelArgs
    do {
      args = try invoke.parseArgs(AgentModelCancelArgs.self)
    } catch {
      invoke.reject(error.localizedDescription, code: "INVALID_ARGS")
      return
    }
    queue.addOperation {
      if let task = self.tasks.removeValue(forKey: args.id) {
        self.streams[task.taskIdentifier]?.cancelled = true
        task.cancel()
      }
      self.refreshing.removeValue(forKey: args.id)?.cancelled = true
      invoke.resolve()
    }
  }

  func key(_ invoke: Invoke) {
    do {
      let args = try invoke.parseArgs(AgentModelKeyArgs.self)
      let account = try AgentModelEndpoint(api: args.api, baseUrl: args.baseUrl).account
      switch args.operation {
      case "has":
        invoke.resolve(["saved": try keys.read(account) != nil])
      case "save" where args.api == "chatgpt":
        throw AgentModelFailure(ChatGPTAuth.signInMessage)
      case "remove" where args.api == "chatgpt":
        Task {
          do {
            try await chatgptTokens.remove(account)
            invoke.resolve()
          } catch {
            invoke.reject(error.localizedDescription, code: "AGENT_KEY")
          }
        }
      case "save":
        let key = (args.key ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty, key.unicodeScalars.allSatisfy({ (0x21...0x7E).contains($0.value) }) else {
          throw AgentModelFailure("Enter the API key as printed, without spaces.")
        }
        try keys.save(key, account: account)
        invoke.resolve()
      case "remove":
        try keys.delete(account)
        invoke.resolve()
      default:
        throw AgentModelFailure("Unknown agent key operation \(args.operation).")
      }
    } catch {
      invoke.reject(error.localizedDescription, code: "AGENT_KEY")
    }
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
    streams[dataTask.taskIdentifier]?.status = (response as? HTTPURLResponse)?.statusCode ?? 0
    completionHandler(.allow)
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    guard let stream = streams[dataTask.taskIdentifier], !stream.cancelled, !stream.truncated else { return }
    if (200..<300).contains(stream.status) {
      stream.channel.send(["type": "chunk", "data": data.base64EncodedString()] as JsonObject)
      return
    }
    stream.body.append(data.prefix(AgentModels.errorBodyLimit - stream.body.count))
    if stream.body.count >= AgentModels.errorBodyLimit {
      stream.truncated = true
      dataTask.cancel()
    }
  }

  /// `start` resolves with `{ deviceAuthId, userCode, verificationUrl, interval, expiresAt }`;
  /// `poll` resolves with `{ status }` and saves the credential when the status is `complete`.
  func chatgpt(_ invoke: Invoke) {
    let args: AgentModelChatGPTArgs
    let account: String
    do {
      args = try invoke.parseArgs(AgentModelChatGPTArgs.self)
      account = try AgentModelEndpoint(api: "chatgpt", baseUrl: nil).account
    } catch {
      invoke.reject(error.localizedDescription, code: "INVALID_ARGS")
      return
    }
    Task {
      do {
        switch args.operation {
        case "start":
          let device = try await chatgptTokens.start()
          invoke.resolve([
            "deviceAuthId": device.deviceAuthId, "userCode": device.userCode,
            "verificationUrl": ChatGPTAuth.verificationUrl, "interval": device.interval,
            "expiresAt": ChatGPTAuth.milliseconds(Date()) + ChatGPTAuth.codeLifetimeMs,
          ])
        case "poll":
          guard let id = args.deviceAuthId, !id.isEmpty, let code = args.userCode, !code.isEmpty else {
            throw AgentModelFailure("Start the ChatGPT sign-in before polling it.")
          }
          invoke.resolve(["status": try await chatgptTokens.poll(deviceAuthId: id, userCode: code, account: account)])
        default:
          throw AgentModelFailure("Unknown ChatGPT sign-in operation \(args.operation).")
        }
      } catch {
        invoke.reject(error.localizedDescription, code: "AGENT_CHATGPT")
      }
    }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    guard let stream = streams.removeValue(forKey: task.taskIdentifier) else { return }
    if tasks[stream.id] === task { tasks.removeValue(forKey: stream.id) }
    if stream.cancelled { return }
    if stream.status == 401, error == nil || stream.truncated, let retry = stream.retry {
      stream.retry = nil
      refreshing[stream.id] = stream
      let id = stream.id
      Task { await resend(id, retry) }
      return
    }
    finish(stream, error: error)
  }

  private func finish(_ stream: Stream, error: Error?) {
    if let error, !stream.truncated {
      stream.channel.send(["type": "failed", "message": error.localizedDescription] as JsonObject)
      return
    }
    var end: JsonObject = ["type": "end", "status": stream.status]
    if !(200..<300).contains(stream.status) { end["body"] = String(decoding: stream.body, as: UTF8.self) }
    stream.channel.send(end)
  }

  // A redirect must not send the API key to another endpoint; the 3xx ends the request as an error.
  func urlSession(_ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void) {
    completionHandler(nil)
  }
}
