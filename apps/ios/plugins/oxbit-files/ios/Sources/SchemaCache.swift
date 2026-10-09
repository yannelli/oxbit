import CryptoKit
import Foundation

enum SchemaCacheError: Error, Equatable {
  case invalidUri
  case tooLarge
  case invalidContent
  case unavailable(String)

  var message: String {
    switch self {
    case .invalidUri: return "Remote JSON schemas require HTTPS without credentials"
    case .tooLarge: return "JSON schema exceeds 5 MiB"
    case .invalidContent: return "Invalid JSON schema content"
    case .unavailable(let reason): return reason
    }
  }
}

/// JSON schema data for the JSON and YAML servers, cached like the desktop runtime's `JsonSchemas`.
/// Offline requests use the last cached copy, then the copy bundled with the app.
final class SchemaCache {
  typealias Fetch = (URL, @escaping (Result<(Data, URLResponse), Error>) -> Void) -> Void
  static let maxBytes = 5 * 1024 * 1024
  static let maxAge: TimeInterval = 24 * 60 * 60
  static let retryDelay: TimeInterval = 60

  let directory: URL
  private let bundled: URL?
  private let fetch: Fetch
  private let now: () -> Date
  private let queue = DispatchQueue(label: "com.yannelli.oxbit.schema-cache")
  private var waiting: [String: [(Result<String, SchemaCacheError>) -> Void]] = [:]
  private var failures: [String: Date] = [:]

  init(directory: URL, bundled: URL? = nil, fetch: Fetch? = nil, now: @escaping () -> Date = Date.init) {
    self.directory = directory
    self.bundled = bundled
    self.fetch = fetch ?? SchemaCache.download
    self.now = now
  }

  static func remoteUrl(_ value: String) -> URL? {
    guard value.count <= 8192, var components = URLComponents(string: value) else { return nil }
    if components.scheme?.lowercased() == "http" { components.scheme = "https" }
    guard components.scheme?.lowercased() == "https", components.user == nil, components.password == nil,
      components.port == nil || components.port == 443, components.host?.isEmpty == false
    else { return nil }
    components.fragment = nil
    return components.url
  }

  func content(_ uri: String, download: Bool, completion: @escaping (Result<String, SchemaCacheError>) -> Void) {
    guard let url = SchemaCache.remoteUrl(uri) else { return completion(.failure(.invalidUri)) }
    queue.async { self.resolve(url.absoluteString, download: download, completion: completion) }
  }

  private func resolve(_ url: String, download: Bool, completion: @escaping (Result<String, SchemaCacheError>) -> Void) {
    let cached = entry(url)
    if let cached, !download || now().timeIntervalSince(cached.fetchedAt) < SchemaCache.maxAge {
      return completion(.success(cached.text))
    }
    let fallback = cached?.text ?? bundledText(url)
    if !download {
      return completion(fallback.map { .success($0) } ?? .failure(.unavailable("Schema downloads are disabled and this schema is not cached")))
    }
    if let retry = failures[url], retry > now() {
      return completion(fallback.map { .success($0) } ?? .failure(.unavailable("Schema download is temporarily unavailable")))
    }
    if waiting[url] != nil { waiting[url]!.append(completion); return }
    waiting[url] = [completion]
    fetch(URL(string: url)!) { result in
      self.queue.async {
        let outcome: Result<String, SchemaCacheError>
        switch result.flatMap({ response in Result { try SchemaCache.validate(response.0, response.1) } }) {
        case .success(let text):
          self.store(url, text: text)
          self.failures.removeValue(forKey: url)
          outcome = .success(text)
        case .failure(let error):
          self.failures[url] = self.now().addingTimeInterval(SchemaCache.retryDelay)
          outcome = fallback.map { .success($0) } ?? .failure((error as? SchemaCacheError) ?? .unavailable(error.localizedDescription))
        }
        for waiter in self.waiting.removeValue(forKey: url) ?? [] { waiter(outcome) }
      }
    }
  }

  static func validate(_ data: Data, _ response: URLResponse) throws -> String {
    if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
      throw SchemaCacheError.unavailable("Schema download failed (\(http.statusCode))")
    }
    if response.url?.scheme?.lowercased() != "https" || response.url.flatMap({ SchemaCache.remoteUrl($0.absoluteString) }) == nil {
      throw SchemaCacheError.invalidUri
    }
    guard data.count <= maxBytes else { throw SchemaCacheError.tooLarge }
    guard let text = String(data: data, encoding: .utf8),
      let value = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]),
      value is [String: Any] || value is Bool
    else { throw SchemaCacheError.invalidContent }
    return text
  }

  private struct Entry: Codable {
    let url: String
    let fetchedAt: Date
    let integrity: String
    let text: String
  }

  static func digest(_ text: String) -> String {
    SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
  }

  func file(_ url: String) -> URL {
    directory.appendingPathComponent(SchemaCache.digest(url) + ".json")
  }

  private func entry(_ url: String) -> Entry? {
    let path = file(url)
    guard let size = (try? FileManager.default.attributesOfItem(atPath: path.path))?[.size] as? Int,
      size <= SchemaCache.maxBytes * 3,
      let data = try? Data(contentsOf: path),
      let value = try? JSONDecoder().decode(Entry.self, from: data),
      value.url == url, value.integrity == SchemaCache.digest(value.text)
    else { return nil }
    return value
  }

  private func store(_ url: String, text: String) {
    do {
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      let data = try JSONEncoder().encode(Entry(url: url, fetchedAt: now(), integrity: SchemaCache.digest(text), text: text))
      try data.write(to: file(url), options: .atomic)
    } catch {
      // The previous entry stays; the downloaded text is still returned.
    }
  }

  private func bundledText(_ url: String) -> String? {
    guard let bundled,
      let data = try? Data(contentsOf: bundled.appendingPathComponent("index.json")),
      let index = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let schemas = index["schemas"] as? [String: [String: Any]],
      let name = schemas[url]?["file"] as? String, !name.contains("/"),
      let schema = try? Data(contentsOf: bundled.appendingPathComponent(name)), schema.count <= SchemaCache.maxBytes
    else { return nil }
    return String(data: schema, encoding: .utf8)
  }

  private static let session: URLSession = {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = 8
    configuration.timeoutIntervalForResource = 8
    return URLSession(configuration: configuration, delegate: HttpsRedirects(), delegateQueue: nil)
  }()

  private static func download(_ url: URL, _ completion: @escaping (Result<(Data, URLResponse), Error>) -> Void) {
    var request = URLRequest(url: url)
    request.setValue("application/schema+json, application/json", forHTTPHeaderField: "Accept")
    session.dataTask(with: request) { data, response, error in
      if let error { return completion(.failure(error)) }
      guard let data, let response else { return completion(.failure(SchemaCacheError.unavailable("Schema download failed"))) }
      completion(.success((data, response)))
    }.resume()
  }
}

private final class HttpsRedirects: NSObject, URLSessionTaskDelegate {
  func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
    completionHandler(request.url.flatMap { SchemaCache.remoteUrl($0.absoluteString) }.map { URLRequest(url: $0) })
  }
}
