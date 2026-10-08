import Foundation

/// Fixed GitHub release assets; release files do not change after publication.
let release = "https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/ripgrep-14.1.1-x86_64-apple-darwin.tar.gz"
let small = (url: release + ".sha256", size: Int64(108),
  sha256: "a8c2b06a7490f4e5ed787973f6ab48d4dbbc73e2ab4e97a4a9e6094e46caaebf")
let large = (url: release, size: Int64(2_082_672),
  sha256: "fc87e78f7cb3fea12d69072e7ef3b21509754717b746368fd40d88963630e2b3")
let offline: Set<URLError.Code> = [.notConnectedToInternet, .cannotFindHost, .cannotConnectToHost,
  .dnsLookupFailed, .timedOut, .networkConnectionLost, .dataNotAllowed, .internationalRoamingOff]

struct Failure: Error { let message: String }

func expect(_ value: Bool, _ message: String) throws {
  guard value else { throw Failure(message: message) }
}

func download(_ store: RuntimeDownloadStore, id: String = "test", url: String, size: Int64,
  sha256: String, then: (() -> Void)? = nil) throws -> Result<URL, RuntimeDownloadError> {
  let done = DispatchSemaphore(value: 0)
  let box = NSLock()
  var result: Result<URL, RuntimeDownloadError>?
  store.download(id: id, url: url, sha256: sha256, size: size) { value in
    box.lock(); result = value; box.unlock()
    done.signal()
  }
  then?()
  guard done.wait(timeout: .now() + 120) == .success else { throw Failure(message: "\(url) timed out") }
  box.lock(); defer { box.unlock() }
  return result!
}

func runTests(_ store: RuntimeDownloadStore) throws {
  let destination = store.directory.appendingPathComponent("\(small.sha256).tar.gz")
  let first = try download(store, url: small.url, size: small.size, sha256: small.sha256)
  if case .failure(.network(let code)) = first, offline.contains(code) {
    print("RuntimeDownload tests skipped: the network is unavailable (URLError \(code.rawValue))")
    exit(0)
  }
  try expect(first == .success(destination), "an HTTPS download with the pinned size and digest saves \(first)")
  try expect(RuntimeDownloadStore.matches(destination, sha256: small.sha256, size: small.size),
    "the saved file matches its digest")

  try Data("corrupt".utf8).write(to: destination)
  let healed = try download(store, url: small.url, size: small.size, sha256: small.sha256)
  try expect(healed == .success(destination)
    && RuntimeDownloadStore.matches(destination, sha256: small.sha256, size: small.size),
    "a cached file with the wrong digest downloads again")

  let plain = small.url.replacingOccurrences(of: "https://", with: "http://")
  try expect(try download(store, url: plain, size: small.size, sha256: small.sha256) == .failure(.invalid),
    "http:// is refused")
  try expect(try download(store, url: small.url, size: small.size, sha256: "ABC") == .failure(.invalid),
    "a malformed digest is refused")

  try FileManager.default.removeItem(at: destination)
  try expect(try download(store, url: small.url, size: small.size - 1, sha256: small.sha256) == .failure(.mismatch),
    "a size mismatch is refused")
  let zeros = String(repeating: "0", count: 64)
  try expect(try download(store, url: small.url, size: small.size, sha256: zeros) == .failure(.mismatch),
    "a digest mismatch is refused")
  try expect(try FileManager.default.contentsOfDirectory(atPath: store.directory.path).isEmpty,
    "refused downloads leave nothing in the cache")

  let cancelled = try download(store, id: "cancel", url: large.url, size: large.size, sha256: large.sha256) {
    store.cancel(id: "cancel")
  }
  try expect(cancelled == .failure(.cancelled), "cancel ends the download: \(cancelled)")
  try expect(!FileManager.default.fileExists(atPath: store.directory.appendingPathComponent("\(large.sha256).tar.gz").path),
    "a cancelled download leaves no archive")
}

let directory = FileManager.default.temporaryDirectory
  .appendingPathComponent("oxbit-runtime-download-\(UUID().uuidString)", isDirectory: true)
defer { try? FileManager.default.removeItem(at: directory) }
do {
  try runTests(RuntimeDownloadStore(directory: directory))
  print("RuntimeDownload tests passed")
} catch {
  FileHandle.standardError.write(Data("RuntimeDownload tests failed: \((error as? Failure)?.message ?? "\(error)")\n".utf8))
  try? FileManager.default.removeItem(at: directory)
  exit(1)
}
