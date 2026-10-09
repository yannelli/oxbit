import Foundation
import JavaScriptCore

@objc protocol LanguageServerHostExports: JSExport {
  func readFile(_ path: String) -> String?
  func fileExists(_ path: String) -> Bool
  func directoryExists(_ path: String) -> Bool
  func list(_ path: String) -> String
}

final class LanguageServerHost: NSObject, LanguageServerHostExports {
  let files: LanguageServerFiles

  init(files: LanguageServerFiles) {
    self.files = files
    super.init()
  }

  func readFile(_ path: String) -> String? { files.readFile(path) }
  func fileExists(_ path: String) -> Bool { files.fileExists(path) }
  func directoryExists(_ path: String) -> Bool { files.directoryExists(path) }
  func list(_ path: String) -> String { files.list(path) }
}

func languageServerError(_ message: String) -> NSError {
  NSError(domain: "OxbitLanguageServer", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
}

/// One bundled server in its own JavaScriptCore context. Timer and schema callbacks run on `queue`.
final class LanguageServerRuntime {
  static let kinds: Set<String> = ["typescript", "json", "yaml", "dockerfile", "shell", "python"]
  static var bundleDirectory: URL { Bundle.main.bundleURL.appendingPathComponent("assets/language-servers", isDirectory: true) }
  static var schemaDirectory: URL {
    FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("json-schemas", isDirectory: true)
  }

  let context: JSContext
  private(set) var server: JSValue!
  private let queue: DispatchQueue
  private var timers: [Int: JSValue] = [:]
  private var nextTimer = 1
  private(set) var disposed = false

  init(kind: String, files: LanguageServerFiles, directory: URL, schemas: SchemaCache?, queue: DispatchQueue,
    log: ((String, String) -> Void)? = nil) throws {
    guard LanguageServerRuntime.kinds.contains(kind) else { throw languageServerError("Unknown language server") }
    guard let context = JSContext() else { throw languageServerError("Could not create the language server JavaScript context") }
    self.context = context
    self.queue = queue
    context.name = "Oxbit \(kind)"
    let script: String
    do {
      script = try String(contentsOf: directory.appendingPathComponent("\(kind).js"), encoding: .utf8)
    } catch {
      throw languageServerError("The bundled \(kind) language server is missing")
    }
    let setTimer: @convention(block) (JSValue, Double) -> Int = { [weak self] callback, milliseconds in
      guard let self, !self.disposed else { return 0 }
      let id = self.nextTimer
      self.nextTimer += 1
      self.timers[id] = callback
      self.queue.asyncAfter(deadline: .now() + max(milliseconds, 0) / 1000) { [weak self] in
        guard let self, !self.disposed, let callback = self.timers.removeValue(forKey: id) else { return }
        callback.call(withArguments: [])
      }
      return id
    }
    let clearTimer: @convention(block) (Int) -> Void = { [weak self] id in self?.timers.removeValue(forKey: id) }
    let now: @convention(block) () -> Double = { ProcessInfo.processInfo.systemUptime * 1000 }
    let write: @convention(block) (String, String) -> Void = { level, message in log?(level, message) }
    context.setObject(setTimer, forKeyedSubscript: "__oxbitSetTimer" as NSString)
    context.setObject(clearTimer, forKeyedSubscript: "__oxbitClearTimer" as NSString)
    context.setObject(now, forKeyedSubscript: "__oxbitNow" as NSString)
    context.setObject(write, forKeyedSubscript: "__oxbitLog" as NSString)
    context.evaluateScript(script, withSourceURL: directory.appendingPathComponent("\(kind).js"))
    if let exception = context.exception {
      context.exception = nil
      throw languageServerError(exception.toString() ?? "Could not load the bundled language server")
    }
    guard let library = context.objectForKeyedSubscript("OxbitLsp"), library.isObject,
      let host = JSValue(object: LanguageServerHost(files: files), in: context)
    else { throw languageServerError("Bundled language server entry point is missing") }
    let resource: @convention(block) (String) -> JSValue = { name in
      LanguageServerRuntime.resource(name, directory: directory, context: JSContext.current())
    }
    let schema: @convention(block) (String, Bool, JSValue) -> Void = { [weak self] uri, download, completion in
      guard let schemas else {
        completion.call(withArguments: [NSNull(), "Remote JSON schemas are unavailable"])
        return
      }
      schemas.content(uri, download: download) { result in
        self?.queue.async {
          guard let self, !self.disposed else { return }
          switch result {
          case .success(let text): completion.call(withArguments: [text, NSNull()])
          case .failure(let error): completion.call(withArguments: [NSNull(), error.message])
          }
        }
      }
    }
    host.setObject(resource, forKeyedSubscript: "resource" as NSString)
    host.setObject(schema, forKeyedSubscript: "schema" as NSString)
    let server = library.invokeMethod("createServer", withArguments: [
      ["root": files.root.path, "rootUri": files.root.absoluteString, "kind": kind], host as Any,
    ])
    if let exception = context.exception {
      context.exception = nil
      throw languageServerError(exception.toString() ?? "Could not initialize the language server")
    }
    guard let server, server.isObject, let handle = server.forProperty("handle"), handle.isObject else {
      throw languageServerError("Bundled language server handler is missing")
    }
    self.server = server
  }

  /// Bundled file names only; the bytes back an ArrayBuffer without a copy.
  private static func resource(_ name: String, directory: URL, context: JSContext?) -> JSValue {
    guard let context, name.range(of: "^[A-Za-z0-9._-]+$", options: .regularExpression) != nil, !name.hasPrefix("."),
      let data = try? Data(contentsOf: directory.appendingPathComponent(name), options: .mappedIfSafe)
    else { return JSValue(nullIn: context) }
    let bytes = UnsafeMutableRawPointer.allocate(byteCount: max(data.count, 1), alignment: 16)
    data.copyBytes(to: bytes.assumingMemoryBound(to: UInt8.self), count: data.count)
    let buffer = JSObjectMakeArrayBufferWithBytesNoCopy(context.jsGlobalContextRef, bytes, data.count, { pointer, _ in pointer?.deallocate() }, nil, nil)
    return JSValue(jsValueRef: buffer, in: context)
  }

  func dispose() {
    disposed = true
    timers.removeAll()
    context.exceptionHandler = nil
    context.exception = nil
  }
}
