import Foundation
import Tauri
import UIKit
import UniformTypeIdentifiers

struct PickFilesArgs: Decodable {
  let multiple: Bool?
}

/// Picks files from the Files app as copies in the app's temporary directory, so Rust reads
/// them without security-scoped access. Rust removes each copy after use.
final class FilePicker: NSObject, UIDocumentPickerDelegate {
  private var pending: Invoke?

  func pick(_ invoke: Invoke, from controller: UIViewController?) {
    let multiple = (try? invoke.parseArgs(PickFilesArgs.self))?.multiple ?? false
    DispatchQueue.main.async {
      guard let controller else {
        invoke.reject("No view controller is available for the file picker", code: "NO_VIEW")
        return
      }
      if self.pending != nil {
        invoke.reject("A file picker is already open", code: "BUSY")
        return
      }
      let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.item], asCopy: true)
      picker.delegate = self
      picker.allowsMultipleSelection = multiple
      self.pending = invoke
      controller.present(picker, animated: true)
    }
  }

  func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
    guard let invoke = pending else { return }
    pending = nil
    guard !urls.isEmpty else {
      invoke.reject("No file was selected", code: "CANCELLED")
      return
    }
    let files: [[String: Any]] = urls.map { url in
      let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
      return ["name": url.lastPathComponent, "path": url.path, "size": size]
    }
    invoke.resolve(["files": files])
  }

  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
    pending?.reject("File selection was cancelled", code: "CANCELLED")
    pending = nil
  }
}
