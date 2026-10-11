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

    init(id: String, channel: Channel) {
      self.id = id
      self.channel = channel
    }
  }

  private static let errorBodyLimit = 65_536
  private let keys = AgentModelKeys()
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

  func stream(_ invoke: Invoke) {
    let args: AgentModelStreamArgs
    var request: URLRequest
    do {
      args = try invoke.parseArgs(AgentModelStreamArgs.self)
      guard args.method == "GET" || args.method == "POST" else {
        throw AgentModelFailure("Unsupported model API method \(args.method).")
      }
      let endpoint = try AgentModelEndpoint(api: args.api, baseUrl: args.baseUrl)
      request = URLRequest(url: try endpoint.url(args.path))
      guard let key = try keys.read(endpoint.account) else {
        invoke.reject("Add an API key in Agent setup", code: "MISSING_KEY")
        return
      }
      endpoint.authorize(&request, key: key)
    } catch {
      invoke.reject(error.localizedDescription, code: "AGENT_MODELS")
      return
    }
    request.httpMethod = args.method
    if args.method == "POST" {
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = Data((args.body ?? "{}").utf8)
    }
    queue.addOperation {
      guard self.tasks[args.id] == nil else {
        invoke.reject("A model request with this id is running", code: "AGENT_MODELS")
        return
      }
      let task = self.session.dataTask(with: request)
      self.streams[task.taskIdentifier] = Stream(id: args.id, channel: args.channel)
      self.tasks[args.id] = task
      task.resume()
      invoke.resolve()
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

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    guard let stream = streams.removeValue(forKey: task.taskIdentifier) else { return }
    if tasks[stream.id] === task { tasks.removeValue(forKey: stream.id) }
    if stream.cancelled { return }
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
