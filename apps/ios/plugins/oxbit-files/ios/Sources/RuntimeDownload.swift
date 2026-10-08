import Foundation
import Tauri

private struct RuntimeDownloadArgs: Decodable {
  let url: String
  let sha256: String
}

/// Downloads the pinned remote runtime archive to Caches; Rust checks its digest before use.
final class RuntimeDownload {
  private lazy var session: URLSession = {
    let config = URLSessionConfiguration.ephemeral
    config.httpShouldSetCookies = false
    config.timeoutIntervalForRequest = 30
    config.timeoutIntervalForResource = 600
    return URLSession(configuration: config)
  }()

  func handle(_ invoke: Invoke) {
    do {
      let args = try invoke.parseArgs(RuntimeDownloadArgs.self)
      guard let url = URL(string: args.url), url.scheme == "https",
        args.sha256.count == 64, args.sha256.allSatisfy({ "0123456789abcdef".contains($0) })
      else { return invoke.reject("Invalid remote runtime download") }
      let directory = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("remote-runtime", isDirectory: true)
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      let destination = directory.appendingPathComponent("\(args.sha256).tar.gz")
      if FileManager.default.fileExists(atPath: destination.path) {
        return invoke.resolve(["path": destination.path])
      }
      session.downloadTask(with: url) { location, response, error in
        guard error == nil, let location, (response as? HTTPURLResponse)?.statusCode == 200 else {
          return invoke.reject("Could not download the remote runtime. Check the network connection and retry.")
        }
        do {
          try? FileManager.default.removeItem(at: destination)
          try FileManager.default.moveItem(at: location, to: destination)
          invoke.resolve(["path": destination.path])
        } catch {
          invoke.reject("Could not save the remote runtime download: \(error.localizedDescription)")
        }
      }.resume()
    } catch {
      invoke.reject(error.localizedDescription)
    }
  }
}
