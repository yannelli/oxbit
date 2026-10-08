import Foundation
import Tauri

private struct RuntimeDownloadArgs: Decodable {
  let id: String
  let url: String
  let sha256: String
  let size: Int64
}

private struct RuntimeDownloadCancelArgs: Decodable {
  let id: String
}

/// Plugin dispatch for `RuntimeDownloadStore`, which saves the archive under Caches.
final class RuntimeDownload {
  private let store = RuntimeDownloadStore(
    directory: FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("remote-runtime", isDirectory: true))

  func handle(_ invoke: Invoke) {
    do {
      let args = try invoke.parseArgs(RuntimeDownloadArgs.self)
      store.download(id: args.id, url: args.url, sha256: args.sha256, size: args.size) { result in
        switch result {
        case .success(let file): invoke.resolve(["path": file.path])
        case .failure(let error): invoke.reject(error.message)
        }
      }
    } catch {
      invoke.reject(error.localizedDescription)
    }
  }

  func cancel(_ invoke: Invoke) {
    do {
      store.cancel(id: try invoke.parseArgs(RuntimeDownloadCancelArgs.self).id)
      invoke.resolve()
    } catch {
      invoke.reject(error.localizedDescription)
    }
  }
}
