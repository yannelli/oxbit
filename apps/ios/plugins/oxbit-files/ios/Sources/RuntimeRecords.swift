import Foundation

/// `RuntimeIdentity` from packages/protocol: `/api/health` and `/api/pair` report it.
struct RuntimeIdentity: Codable, Equatable {
  let id: String
  let name: String
  let version: String
  let startedAt: Double

  static func validId(_ id: String) -> Bool {
    (8...64).contains(id.count)
      && id.unicodeScalars.allSatisfy { $0.isASCII && (CharacterSet.alphanumerics.contains($0) || $0 == "-") }
  }

  init?(json: Any?) {
    guard let json = json as? [String: Any],
      let id = json["id"] as? String, RuntimeIdentity.validId(id),
      let name = json["name"] as? String, let version = json["version"] as? String,
      let startedAt = json["startedAt"] as? NSNumber
    else { return nil }
    self.init(id: id, name: name, version: version, startedAt: startedAt.doubleValue)
  }

  init(id: String, name: String, version: String, startedAt: Double) {
    self.id = id
    self.name = name
    self.version = version
    self.startedAt = startedAt
  }
}

/// Keychain accounts: `runtime-id:<id>` for a known runtime, the normalized URL before that.
enum RuntimeAccount {
  static func id(_ runtimeId: String) -> String { "runtime-id:\(runtimeId)" }

  static func url(_ url: URL) -> String {
    url.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
  }

  /// An http or https origin without credentials, path, query, or fragment.
  static func origin(_ string: String) -> URL? {
    guard let components = URLComponents(string: string),
      ["http", "https"].contains(components.scheme ?? ""),
      let host = components.host, !host.isEmpty,
      components.user == nil, components.password == nil,
      components.query == nil, components.fragment == nil,
      components.path.isEmpty || components.path == "/"
    else { return nil }
    return components.url
  }
}

/// A runtime found by Bonjour, in the shape of host-ios `DiscoveredRuntime`.
struct DiscoveredRuntime: Encodable, Equatable {
  let runtimeId: String
  let name: String
  let version: String?
  let host: String
  let port: Int
  let url: String

  /// `txt` holds the `_oxbit._tcp` TXT keys; the resolved port wins over the TXT `port`.
  init?(txt: [String: String], service: String, host: String, port: UInt16?) {
    guard let id = txt["id"], RuntimeIdentity.validId(id) else { return nil }
    let host = DiscoveredRuntime.host(host)
    guard !host.isEmpty, let port = port.map(Int.init) ?? txt["port"].flatMap(Int.init),
      (1...65535).contains(port)
    else { return nil }
    runtimeId = id
    name = txt["name"].flatMap { $0.isEmpty ? nil : $0 } ?? service
    version = txt["version"].flatMap { $0.isEmpty ? nil : $0 }
    self.host = host
    self.port = port
    url = DiscoveredRuntime.url(host: host, port: port)
  }

  static func host(_ value: String) -> String {
    String(value.split(separator: "%", maxSplits: 1).first ?? "")
  }

  static func url(host: String, port: Int) -> String {
    host.contains(":") ? "http://[\(host)]:\(port)" : "http://\(host):\(port)"
  }

  /// One entry per runtime id, IPv4 first, ordered by name.
  static func unique(_ runtimes: [DiscoveredRuntime]) -> [DiscoveredRuntime] {
    var byId: [String: DiscoveredRuntime] = [:]
    for runtime in runtimes {
      if let kept = byId[runtime.runtimeId], !kept.host.contains(":") || runtime.host.contains(":") { continue }
      byId[runtime.runtimeId] = runtime
    }
    return byId.values.sorted { ($0.name, $0.runtimeId) < ($1.name, $1.runtimeId) }
  }
}
