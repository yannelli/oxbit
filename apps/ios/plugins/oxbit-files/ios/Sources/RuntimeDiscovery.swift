import Foundation
import Network
import Tauri

private struct RuntimeDiscoveryArgs: Decodable {
  let operation: String
}

private struct RuntimeDiscoveryList: Encodable {
  let runtimes: [DiscoveredRuntime]
  let hosts: [DiscoveredRemoteHost]
  let localNetworkDenied: Bool
}

/// Browses `_oxbit._tcp` runtimes and `_oxbit-remote._tcp` remote access hosts in `local.`.
/// The WebView polls `list`; browsing ends on `stop` or after two minutes without `start` or `list`.
final class RuntimeDiscovery {
  private static let idle: TimeInterval = 120
  private let queue = DispatchQueue(label: "com.yannelli.oxbit.runtime-discovery")
  private lazy var runtimes = BonjourServices(type: "_oxbit._tcp", queue: queue)
  private lazy var hosts = BonjourServices(type: "_oxbit-remote._tcp", queue: queue)
  private var wanted = false
  private var idleTimer: DispatchWorkItem?

  func handle(_ invoke: Invoke) {
    let operation: String
    do {
      operation = try invoke.parseArgs(RuntimeDiscoveryArgs.self).operation
    } catch {
      invoke.reject(error.localizedDescription, code: "RUNTIME_DISCOVERY")
      return
    }
    queue.async {
      switch operation {
      case "start":
        self.wanted = true
        self.browse()
      case "list":
        if self.wanted { self.browse() }
      case "stop":
        self.wanted = false
        self.cancel()
      default:
        invoke.reject("Unknown runtime discovery operation.", code: "RUNTIME_DISCOVERY")
        return
      }
      invoke.resolve(self.list())
    }
  }

  private func list() -> RuntimeDiscoveryList {
    RuntimeDiscoveryList(
      runtimes: DiscoveredRuntime.unique(runtimes.resolved.compactMap {
        DiscoveredRuntime(txt: $0.txt, service: $0.service, host: $0.host, port: $0.port)
      }),
      hosts: DiscoveredRemoteHost.unique(hosts.resolved.compactMap {
        DiscoveredRemoteHost(txt: $0.txt, service: $0.service, host: $0.host, port: $0.port)
      }),
      localNetworkDenied: runtimes.localNetworkDenied || hosts.localNetworkDenied)
  }

  private func browse() {
    idleTimer?.cancel()
    let timer = DispatchWorkItem { [weak self] in self?.cancel() }
    idleTimer = timer
    queue.asyncAfter(deadline: .now() + Self.idle, execute: timer)
    runtimes.start()
    hosts.start()
  }

  private func cancel() {
    idleTimer?.cancel()
    idleTimer = nil
    runtimes.cancel()
    hosts.cancel()
  }
}

private struct ResolvedService {
  let txt: [String: String]
  let service: String
  let host: String
  let port: UInt16
}

/// One Bonjour service type and the address each of its services resolved to. Call it on `queue`.
private final class BonjourServices {
  private static let policyDenied = DNSServiceErrorType(kDNSServiceErr_PolicyDenied)
  private static let resolveTimeout: TimeInterval = 5
  private let type: String
  private let queue: DispatchQueue
  private var browser: NWBrowser?
  /// The browser waits with PolicyDenied while Local Network access is off, and turns ready when it is allowed.
  private(set) var localNetworkDenied = false
  private var services: [NWEndpoint: [String: String]] = [:]
  private var addresses: [NWEndpoint: ResolvedService] = [:]
  private var probes: [NWEndpoint: NWConnection] = [:]

  var resolved: [ResolvedService] { Array(addresses.values) }

  init(type: String, queue: DispatchQueue) {
    self.type = type
    self.queue = queue
  }

  func start() {
    guard browser == nil else { return }
    let browser = NWBrowser(for: .bonjourWithTXTRecord(type: type, domain: nil), using: NWParameters())
    browser.stateUpdateHandler = { [weak self, weak browser] state in
      guard let self, let browser, self.browser === browser else { return }
      switch state {
      case .failed:
        self.cancel()
      case .waiting(.dns(Self.policyDenied)):
        self.localNetworkDenied = true
      case .ready:
        self.localNetworkDenied = false
      default:
        break
      }
    }
    browser.browseResultsChangedHandler = { [weak self] results, _ in self?.update(results) }
    self.browser = browser
    browser.start(queue: queue)
  }

  func cancel() {
    browser?.cancel()
    browser = nil
    localNetworkDenied = false
    probes.values.forEach { $0.cancel() }
    probes.removeAll()
    services.removeAll()
    addresses.removeAll()
  }

  private func update(_ results: Set<NWBrowser.Result>) {
    var current: [NWEndpoint: [String: String]] = [:]
    for result in results {
      guard case .bonjour(let txt) = result.metadata else { continue }
      current[result.endpoint] = txt.dictionary
    }
    for endpoint in services.keys where current[endpoint] == nil {
      probes.removeValue(forKey: endpoint)?.cancel()
      addresses.removeValue(forKey: endpoint)
    }
    for (endpoint, txt) in current where services[endpoint] != txt {
      addresses.removeValue(forKey: endpoint)
      probes.removeValue(forKey: endpoint)?.cancel()
      if txt["id"] != nil { resolve(endpoint, txt: txt, ipv4: true) }
    }
    services = current
  }

  /// A short-lived connection reports the address Bonjour resolved; IPv4 first, then any family.
  private func resolve(_ endpoint: NWEndpoint, txt: [String: String], ipv4: Bool) {
    let parameters = NWParameters.tcp
    if ipv4, let ip = parameters.defaultProtocolStack.internetProtocol as? NWProtocolIP.Options {
      ip.version = .v4
    }
    let connection = NWConnection(to: endpoint, using: parameters)
    probes[endpoint] = connection
    let finish = { [weak self, weak connection] (address: (String, UInt16)?) in
      guard let self, let connection, self.probes[endpoint] === connection else { return }
      connection.cancel()
      self.probes.removeValue(forKey: endpoint)
      if let (host, port) = address {
        self.addresses[endpoint] = ResolvedService(txt: txt, service: Self.service(endpoint), host: host, port: port)
      } else if ipv4 {
        self.resolve(endpoint, txt: txt, ipv4: false)
      }
    }
    connection.stateUpdateHandler = { [weak connection] state in
      switch state {
      case .ready:
        guard case .hostPort(let host, let port) = connection?.currentPath?.remoteEndpoint else { return finish(nil) }
        finish((Self.host(host), port.rawValue))
      case .failed, .waiting:
        finish(nil)
      default:
        break
      }
    }
    connection.start(queue: queue)
    queue.asyncAfter(deadline: .now() + Self.resolveTimeout) { finish(nil) }
  }

  private static func host(_ host: NWEndpoint.Host) -> String {
    switch host {
    case .ipv4(let address): return "\(address)"
    case .ipv6(let address): return "\(address)"
    case .name(let name, _): return name
    @unknown default: return ""
    }
  }

  private static func service(_ endpoint: NWEndpoint) -> String {
    if case .service(let name, _, _, _) = endpoint { return name }
    return ""
  }
}
