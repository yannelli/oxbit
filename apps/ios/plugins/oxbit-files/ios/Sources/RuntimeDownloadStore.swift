import CryptoKit
import Foundation

enum RuntimeDownloadError: Error, Equatable {
  case invalid
  case network(URLError.Code)
  case status(Int)
  case mismatch
  case cancelled
  case save(String)

  var message: String {
    switch self {
    case .invalid: return "Invalid remote runtime download"
    case .network, .status: return "Could not download the remote runtime. Check the network connection and retry."
    case .mismatch: return "The remote runtime download did not match its pinned size and SHA-256."
    case .cancelled: return "The remote runtime download was cancelled."
    case .save(let reason): return "Could not save the remote runtime download: \(reason)"
    }
  }
}

/// Downloads the pinned remote runtime archive to `<directory>/<sha256>.tar.gz` and keeps it only
/// when its size and SHA-256 match. Each caller ID has at most one download, which `cancel` ends.
final class RuntimeDownloadStore {
  let directory: URL
  private let session: URLSession
  private let lock = NSLock()
  private var tasks: [String: URLSessionDownloadTask] = [:]

  init(directory: URL, session: URLSession = RuntimeDownloadStore.defaultSession()) {
    self.directory = directory
    self.session = session
  }

  static func defaultSession() -> URLSession {
    let config = URLSessionConfiguration.ephemeral
    config.httpShouldSetCookies = false
    config.timeoutIntervalForRequest = 30
    config.timeoutIntervalForResource = 600
    return URLSession(configuration: config)
  }

  static func validated(url: String, sha256: String, size: Int64) -> URL? {
    guard let parsed = URL(string: url), parsed.scheme == "https", parsed.host?.isEmpty == false,
      sha256.count == 64, sha256.allSatisfy({ "0123456789abcdef".contains($0) }), size > 0
    else { return nil }
    return parsed
  }

  static func matches(_ file: URL, sha256: String, size: Int64) -> Bool {
    guard let attributes = try? FileManager.default.attributesOfItem(atPath: file.path),
      (attributes[.size] as? NSNumber)?.int64Value == size,
      let handle = try? FileHandle(forReadingFrom: file)
    else { return false }
    defer { try? handle.close() }
    var hasher = SHA256()
    while let chunk = try? handle.read(upToCount: 1 << 20), !chunk.isEmpty {
      hasher.update(data: chunk)
    }
    return hasher.finalize().map { String(format: "%02x", $0) }.joined() == sha256
  }

  func download(id: String, url: String, sha256: String, size: Int64,
    completion: @escaping (Result<URL, RuntimeDownloadError>) -> Void) {
    guard let source = Self.validated(url: url, sha256: sha256, size: size) else {
      return completion(.failure(.invalid))
    }
    let destination = directory.appendingPathComponent("\(sha256).tar.gz")
    if Self.matches(destination, sha256: sha256, size: size) {
      return completion(.success(destination))
    }
    do {
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    } catch {
      return completion(.failure(.save(error.localizedDescription)))
    }
    let token = UUID().uuidString
    let task = session.downloadTask(with: source) { [weak self] location, response, error in
      self?.forget(id, token: token)
      if let error {
        let code = (error as? URLError)?.code ?? .unknown
        return completion(.failure(code == .cancelled ? .cancelled : .network(code)))
      }
      let status = (response as? HTTPURLResponse)?.statusCode ?? 0
      guard let location, status == 200 else { return completion(.failure(.status(status))) }
      guard Self.matches(location, sha256: sha256, size: size) else {
        try? FileManager.default.removeItem(at: location)
        return completion(.failure(.mismatch))
      }
      do {
        try? FileManager.default.removeItem(at: destination)
        try FileManager.default.moveItem(at: location, to: destination)
        completion(.success(destination))
      } catch {
        completion(.failure(.save(error.localizedDescription)))
      }
    }
    task.taskDescription = token
    lock.lock()
    let previous = tasks.updateValue(task, forKey: id)
    lock.unlock()
    previous?.cancel()
    task.resume()
  }

  func cancel(id: String) {
    lock.lock()
    let task = tasks.removeValue(forKey: id)
    lock.unlock()
    task?.cancel()
  }

  private func forget(_ id: String, token: String) {
    lock.lock()
    if tasks[id]?.taskDescription == token { tasks[id] = nil }
    lock.unlock()
  }
}
