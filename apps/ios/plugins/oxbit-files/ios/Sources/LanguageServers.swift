import Foundation
import JavaScriptCore
import Tauri

private struct LanguageServerArgs: Decodable {
  let workspaceId: String
  let sessionId: String
  let root: String
  let kind: String
  let method: String
  let paramsJson: String
}

private struct LanguageServerWorkspaceArgs: Decodable {
  let workspaceId: String
}

private struct LanguageServerResponse: Encodable {
  let payload: String
}

@objc private protocol LanguageServerHostExports: JSExport {
  func readFile(_ path: String) -> String?
  func fileExists(_ path: String) -> Bool
  func directoryExists(_ path: String) -> Bool
  func list(_ path: String) -> String
}

private final class LanguageServerHost: NSObject, LanguageServerHostExports {
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

private final class LanguageServerReply {
  private let invoke: Invoke
  private(set) var finished = false

  init(_ invoke: Invoke) {
    self.invoke = invoke
  }

  func resolve(_ payload: String) throws {
    guard !finished else { return }
    guard let response = try JSONSerialization.jsonObject(with: Data(payload.utf8)) as? [String: Any],
      response["notifications"] is [[String: Any]]
    else { throw languageServerError("Language server returned an invalid response") }
    finished = true
    invoke.resolve(LanguageServerResponse(payload: payload))
  }

  func reject(_ message: String) {
    guard !finished else { return }
    finished = true
    invoke.reject(message, code: "LSP")
  }
}

private final class LanguageServerSession {
  let workspaceId: String
  let root: String
  let kind: String
  let context: JSContext
  let server: JavaScriptCore.JSValue
  let files: LanguageServerFiles
  var pending: [UUID: LanguageServerReply] = [:]

  init(args: LanguageServerArgs, context: JSContext, server: JavaScriptCore.JSValue, files: LanguageServerFiles) {
    workspaceId = args.workspaceId
    root = args.root
    kind = args.kind
    self.context = context
    self.server = server
    self.files = files
  }

  func matches(_ args: LanguageServerArgs) -> Bool {
    workspaceId == args.workspaceId && root == args.root && kind == args.kind
  }
}

private func languageServerError(_ message: String) -> NSError {
  NSError(domain: "OxbitLanguageServer", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
}

final class LanguageServers {
  private let queue = DispatchQueue(label: "com.yannelli.oxbit.language-servers", qos: .userInitiated)
  private var sessions: [String: LanguageServerSession] = [:]

  func handle(_ invoke: Invoke) {
    do {
      let args = try invoke.parseArgs(LanguageServerArgs.self)
      guard !args.workspaceId.isEmpty, !args.sessionId.isEmpty,
        ["typescript", "json"].contains(args.kind)
      else { throw languageServerError("Invalid language server session") }
      queue.async {
        do { try self.handle(args, invoke: invoke) }
        catch { invoke.reject(error.localizedDescription, code: "LSP") }
      }
    } catch {
      invoke.reject(error.localizedDescription, code: "LSP")
    }
  }

  func closeWorkspace(_ invoke: Invoke) {
    do {
      let args = try invoke.parseArgs(LanguageServerWorkspaceArgs.self)
      queue.async {
        let ids = self.sessions.filter { $0.value.workspaceId == args.workspaceId }.map { $0.key }
        for id in ids {
          if let session = self.sessions[id] {
            self.discard(id, session: session, message: "Workspace root is not open")
          }
        }
        invoke.resolve()
      }
    } catch {
      invoke.reject(error.localizedDescription, code: "LSP")
    }
  }

  private func handle(_ args: LanguageServerArgs, invoke: Invoke) throws {
    if let session = sessions[args.sessionId], !session.matches(args) {
      throw languageServerError("Language server session belongs to another workspace or server")
    }
    if args.method == "exit" {
      if let session = sessions[args.sessionId] {
        discard(args.sessionId, session: session, message: "Language server session exited")
      }
      invoke.resolve(LanguageServerResponse(payload: "{\"notifications\":[]}"))
      return
    }
    let session: LanguageServerSession
    if let existing = sessions[args.sessionId] {
      session = existing
    } else {
      guard args.method == "initialize" else {
        throw languageServerError("Language server session is not initialized")
      }
      session = try createSession(args)
      sessions[args.sessionId] = session
    }
    let id = UUID()
    let reply = LanguageServerReply(invoke)
    session.pending[id] = reply
    session.context.exception = nil
    session.context.exceptionHandler = { [weak self, weak session] context, exception in
      context?.exception = exception
      guard let self, let session else { return }
      self.discard(args.sessionId, session: session,
        message: exception?.toString() ?? "Language server JavaScript failed")
    }
    let completion: @convention(block) (String) -> Void = { [weak self, weak session] payload in
      guard let self, let session, !reply.finished else { return }
      do {
        try reply.resolve(payload)
        session.pending.removeValue(forKey: id)
      } catch {
        self.discard(args.sessionId, session: session, message: error.localizedDescription)
      }
    }
    session.server.invokeMethod("handle", withArguments: [args.method, args.paramsJson, completion])
    queue.asyncAfter(deadline: .now() + 30) { [weak self, weak session, weak reply] in
      guard let self, let session, let reply, !reply.finished else { return }
      self.discard(args.sessionId, session: session, message: "Language server request timed out")
    }
  }

  private func createSession(_ args: LanguageServerArgs) throws -> LanguageServerSession {
    let files = LanguageServerFiles(root: args.root)
    guard files.directoryExists(args.root) else {
      throw languageServerError("Workspace root is not accessible")
    }
    guard let context = JSContext() else {
      throw languageServerError("Could not create the language server JavaScript context")
    }
    context.name = "Oxbit \(args.kind) \(args.sessionId)"
    context.evaluateScript(LanguageServerBundle.script)
    if let exception = context.exception {
      let message = exception.toString() ?? "Could not load bundled language servers"
      context.exception = nil
      throw languageServerError(message)
    }
    guard let library = context.objectForKeyedSubscript("OxbitLsp"), library.isObject
    else { throw languageServerError("Bundled language server entry point is missing") }
    let server = library.invokeMethod("createServer", withArguments: [
      ["root": files.root.path, "rootUri": files.root.absoluteString, "kind": args.kind],
      LanguageServerHost(files: files)
    ])
    if let exception = context.exception {
      let message = exception.toString() ?? "Could not initialize the language server"
      context.exception = nil
      throw languageServerError(message)
    }
    guard let server, server.isObject, let handle = server.forProperty("handle"), handle.isObject else {
      throw languageServerError("Bundled language server handler is missing")
    }
    return LanguageServerSession(args: args, context: context, server: server, files: files)
  }

  private func discard(_ id: String, session: LanguageServerSession, message: String) {
    session.files.close()
    session.context.exceptionHandler = nil
    session.context.exception = nil
    for reply in session.pending.values { reply.reject(message) }
    session.pending.removeAll()
    if sessions[id] === session { sessions.removeValue(forKey: id) }
  }
}
