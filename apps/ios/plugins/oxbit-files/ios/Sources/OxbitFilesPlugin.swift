import Foundation
import Tauri
import UIKit
import UniformTypeIdentifiers
import WebKit

struct FolderArgs: Decodable {
  let id: String
}

struct FolderResult: Encodable {
  let id: String
  let name: String
  let path: String
  let stale: Bool
}

enum FolderError: LocalizedError {
  case accessDenied
  var errorDescription: String? { "Access to the folder was denied" }
}

/// Owns the document picker and the security-scoped URLs. Rust reads and writes the resolved paths.
class OxbitFilesPlugin: Plugin, UIDocumentPickerDelegate {
  private var pending: Invoke?
  private var open: [String: URL] = [:]

  private var bookmarks: URL {
    let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    return support.appendingPathComponent("com.yannelli.oxbit/bookmarks", isDirectory: true)
  }

  private func bookmarkFile(_ id: String) -> URL {
    bookmarks.appendingPathComponent(id)
  }

  @objc public func pickFolder(_ invoke: Invoke) {
    DispatchQueue.main.async {
      guard let controller = self.manager.viewController else {
        invoke.reject("No view controller is available for the folder picker", code: "NO_VIEW")
        return
      }
      if self.pending != nil {
        invoke.reject("A folder picker is already open", code: "BUSY")
        return
      }
      let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder], asCopy: false)
      picker.delegate = self
      picker.allowsMultipleSelection = false
      self.pending = invoke
      controller.present(picker, animated: true)
    }
  }

  public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
    guard let invoke = pending else { return }
    pending = nil
    guard let url = urls.first else {
      invoke.reject("No folder was selected", code: "CANCELLED")
      return
    }
    do {
      invoke.resolve(try register(url))
    } catch {
      invoke.reject(error.localizedDescription, code: "BOOKMARK")
    }
  }

  public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
    pending?.reject("Folder selection was cancelled", code: "CANCELLED")
    pending = nil
  }

  private func register(_ url: URL) throws -> FolderResult {
    guard url.startAccessingSecurityScopedResource() else { throw FolderError.accessDenied }
    let data = try url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
    try FileManager.default.createDirectory(at: bookmarks, withIntermediateDirectories: true)
    let id = UUID().uuidString
    try data.write(to: bookmarkFile(id), options: .atomic)
    open[id] = url
    return FolderResult(id: id, name: url.lastPathComponent, path: url.path, stale: false)
  }

  @objc public func openFolder(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(FolderArgs.self)
    if let url = open[args.id] {
      invoke.resolve(FolderResult(id: args.id, name: url.lastPathComponent, path: url.path, stale: false))
      return
    }
    guard let data = try? Data(contentsOf: bookmarkFile(args.id)) else {
      invoke.reject("This folder is no longer remembered", code: "NOT_FOUND")
      return
    }
    var stale = false
    let url: URL
    do {
      url = try URL(resolvingBookmarkData: data, options: [.withoutUI], relativeTo: nil, bookmarkDataIsStale: &stale)
    } catch {
      invoke.reject("The folder could not be located: \(error.localizedDescription)", code: "STALE")
      return
    }
    guard url.startAccessingSecurityScopedResource() else {
      invoke.reject("Access to this folder was not granted; choose it again", code: "STALE")
      return
    }
    if stale, let fresh = try? url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil) {
      try? fresh.write(to: bookmarkFile(args.id), options: .atomic)
    }
    open[args.id] = url
    invoke.resolve(FolderResult(id: args.id, name: url.lastPathComponent, path: url.path, stale: stale))
  }

  @objc public func closeFolder(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(FolderArgs.self)
    open.removeValue(forKey: args.id)?.stopAccessingSecurityScopedResource()
    invoke.resolve()
  }

  @objc public func forgetFolder(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(FolderArgs.self)
    open.removeValue(forKey: args.id)?.stopAccessingSecurityScopedResource()
    try? FileManager.default.removeItem(at: bookmarkFile(args.id))
    invoke.resolve()
  }

  @objc public func documentsPath(_ invoke: Invoke) {
    let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    invoke.resolve(["path": documents.path])
  }
}

@_cdecl("init_plugin_oxbit_files")
func initPlugin() -> Plugin {
  return OxbitFilesPlugin()
}
