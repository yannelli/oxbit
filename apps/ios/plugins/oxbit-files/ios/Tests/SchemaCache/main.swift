import Foundation

struct Failure: Error { let message: String }

func expect(_ value: Bool, _ message: String) throws {
  guard value else { throw Failure(message: message) }
}

final class Network {
  var calls: [URL] = []
  var replies: [String: Result<(Data, URLResponse), Error>] = [:]

  func fetch(_ url: URL, _ completion: @escaping (Result<(Data, URLResponse), Error>) -> Void) {
    calls.append(url)
    completion(replies[url.absoluteString] ?? .failure(URLError(.notConnectedToInternet)))
  }

  func reply(_ url: String, _ body: String, status: Int = 200, final: String? = nil) {
    let response = HTTPURLResponse(url: URL(string: final ?? url)!, statusCode: status, httpVersion: nil, headerFields: nil)!
    replies[url] = .success((Data(body.utf8), response))
  }
}

func content(_ cache: SchemaCache, _ uri: String, download: Bool = true) -> Result<String, SchemaCacheError> {
  let done = DispatchSemaphore(value: 0)
  var result: Result<String, SchemaCacheError>!
  cache.content(uri, download: download) { value in result = value; done.signal() }
  done.wait()
  return result
}

let root = FileManager.default.temporaryDirectory.appendingPathComponent("oxbit-schema-cache-\(UUID().uuidString)")
defer { try? FileManager.default.removeItem(at: root) }
let bundled = root.appendingPathComponent("bundled")
try FileManager.default.createDirectory(at: bundled, withIntermediateDirectories: true)
try #"{"schemas":{"https://example.test/bundled.json":{"file":"bundled.schema.json"},"https://example.test/escape.json":{"file":"../secret.json"}}}"#
  .write(to: bundled.appendingPathComponent("index.json"), atomically: true, encoding: .utf8)
try #"{"title":"bundled"}"#.write(to: bundled.appendingPathComponent("bundled.schema.json"), atomically: true, encoding: .utf8)
try #"{"title":"secret"}"#.write(to: root.appendingPathComponent("secret.json"), atomically: true, encoding: .utf8)

var clock = Date(timeIntervalSince1970: 1_800_000_000)
let network = Network()
let cache = SchemaCache(directory: root.appendingPathComponent("cache"), bundled: bundled, fetch: network.fetch, now: { clock })
let schema = "https://example.test/schema.json"

do {
  try expect(content(cache, "http://user:pass@example.test/a.json") == .failure(.invalidUri), "credentials are rejected")
  try expect(content(cache, "https://example.test:8443/a.json") == .failure(.invalidUri), "non-default ports are rejected")
  try expect(content(cache, "file:///etc/passwd") == .failure(.invalidUri), "file URIs are rejected")
  try expect(network.calls.isEmpty, "rejected URIs are not fetched")

  network.reply(schema, #"{"title":"first"}"#)
  try expect(content(cache, "http://example.test/schema.json#/definitions") == .success(#"{"title":"first"}"#), "HTTP upgrades to HTTPS and drops the fragment")
  try expect(network.calls.map(\.absoluteString) == [schema], "the first request downloads once")
  network.reply(schema, #"{"title":"second"}"#)
  clock.addTimeInterval(SchemaCache.maxAge - 1)
  try expect(content(cache, schema) == .success(#"{"title":"first"}"#), "a fresh entry is served from the cache")
  try expect(network.calls.count == 1, "a fresh entry does not download")
  clock.addTimeInterval(2)
  try expect(content(cache, schema) == .success(#"{"title":"second"}"#), "a stale entry downloads again")

  network.replies[schema] = .failure(URLError(.notConnectedToInternet))
  clock.addTimeInterval(SchemaCache.maxAge + 1)
  try expect(content(cache, schema) == .success(#"{"title":"second"}"#), "offline requests use the stale cached copy")
  let calls = network.calls.count
  try expect(content(cache, schema) == .success(#"{"title":"second"}"#) && network.calls.count == calls, "failures wait before retrying")
  clock.addTimeInterval(SchemaCache.retryDelay + 1)
  _ = content(cache, schema)
  try expect(network.calls.count == calls + 1, "a download retries after the delay")
  try expect(content(cache, schema, download: false) == .success(#"{"title":"second"}"#), "disabled downloads use a stale cached copy")

  let other = "https://example.test/other.json"
  network.reply(other, String(repeating: " ", count: SchemaCache.maxBytes) + "{}")
  try expect(content(cache, other) == .failure(.tooLarge), "schemas over 5 MiB are rejected")
  clock.addTimeInterval(SchemaCache.retryDelay + 1)
  network.reply(other, "[1, 2]")
  try expect(content(cache, other) == .failure(.invalidContent), "arrays are not schemas")
  clock.addTimeInterval(SchemaCache.retryDelay + 1)
  network.reply(other, "{}", status: 404)
  try expect(content(cache, other) == .failure(.unavailable("Schema download failed (404)")), "HTTP errors are reported")
  clock.addTimeInterval(SchemaCache.retryDelay + 1)
  network.reply(other, "{}", final: "http://insecure.test/other.json")
  try expect(content(cache, other) == .failure(.invalidUri), "redirects must stay on HTTPS")
  try expect(content(cache, other, download: false) == .failure(.unavailable("Schema downloads are disabled and this schema is not cached")), "disabled downloads without a copy fail")

  try expect(content(cache, "https://example.test/bundled.json", download: false) == .success(#"{"title":"bundled"}"#), "the bundled copy serves first launch offline")
  try expect(content(cache, "https://example.test/bundled.json") == .success(#"{"title":"bundled"}"#), "a failed download falls back to the bundled copy")
  try expect(content(cache, "https://example.test/escape.json", download: false) != .success(#"{"title":"secret"}"#), "bundled names stay inside the bundle")

  let file = cache.file(schema)
  var stored = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as! [String: Any]
  stored["text"] = #"{"title":"tampered"}"#
  try JSONSerialization.data(withJSONObject: stored).write(to: file)
  try expect(content(cache, schema, download: false) == .failure(.unavailable("Schema downloads are disabled and this schema is not cached")), "an entry with a wrong digest is ignored")
  print("SchemaCache tests passed")
} catch let failure as Failure {
  print("SchemaCache test failed: \(failure.message)")
  exit(1)
}
