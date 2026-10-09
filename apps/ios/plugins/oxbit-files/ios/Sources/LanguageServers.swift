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
  let queue: DispatchQueue
  var runtime: LanguageServerRuntime?
  var files: LanguageServerFiles?
  var pending: [UUID: LanguageServerReply] = [:]
  var closed = false

  init(args: LanguageServerArgs) {
    workspaceId = args.workspaceId
    root = args.root
    kind = args.kind
    queue = DispatchQueue(label: "com.yannelli.oxbit.language-server.\(args.kind)", qos: .userInitiated)
  }

  func matches(_ args: LanguageServerArgs) -> Bool {
    workspaceId == args.workspaceId && root == args.root && kind == args.kind
  }
}

/// Sessions run on their own serial queues so a slow server does not delay other languages.
final class LanguageServers {
  private let queue = DispatchQueue(label: "com.yannelli.oxbit.language-servers", qos: .userInitiated)
  private var sessions: [String: LanguageServerSession] = [:]
  private lazy var schemas = SchemaCache(
    directory: LanguageServerRuntime.schemaDirectory,
    bundled: LanguageServerRuntime.bundleDirectory.appendingPathComponent("schemas", isDirectory: true))

  func handle(_ invoke: Invoke) {
    do {
      let args = try invoke.parseArgs(LanguageServerArgs.self)
      guard !args.workspaceId.isEmpty, !args.sessionId.isEmpty, LanguageServerRuntime.kinds.contains(args.kind)
      else { throw languageServerError("Invalid language server session") }
      queue.async {
        if let session = self.sessions[args.sessionId], !session.matches(args) {
          return invoke.reject("Language server session belongs to another workspace or server", code: "LSP")
        }
        if args.method == "exit" {
          if let session = self.sessions.removeValue(forKey: args.sessionId) {
            session.queue.async { self.close(session, message: "Language server session exited") }
          }
          return invoke.resolve(LanguageServerResponse(payload: "{\"notifications\":[]}"))
        }
        let session: LanguageServerSession
        if let existing = self.sessions[args.sessionId] {
          session = existing
        } else {
          guard args.method == "initialize" else {
            return invoke.reject("Language server session is not initialized", code: "LSP")
          }
          session = LanguageServerSession(args: args)
          self.sessions[args.sessionId] = session
        }
        session.queue.async {
          do { try self.handle(args, session: session, invoke: invoke) }
          catch {
            invoke.reject(error.localizedDescription, code: "LSP")
            if session.runtime == nil { self.discard(args.sessionId, session: session, message: error.localizedDescription) }
          }
        }
      }
    } catch {
      invoke.reject(error.localizedDescription, code: "LSP")
    }
  }

  func closeWorkspace(_ invoke: Invoke) {
    do {
      let args = try invoke.parseArgs(LanguageServerWorkspaceArgs.self)
      queue.async {
        let closing = self.sessions.filter { $0.value.workspaceId == args.workspaceId }
        for (id, session) in closing { self.sessions.removeValue(forKey: id) }
        let group = DispatchGroup()
        for session in closing.values {
          session.queue.async(group: group) { self.close(session, message: "Workspace root is not open") }
        }
        group.notify(queue: self.queue) { invoke.resolve() }
      }
    } catch {
      invoke.reject(error.localizedDescription, code: "LSP")
    }
  }

  private func handle(_ args: LanguageServerArgs, session: LanguageServerSession, invoke: Invoke) throws {
    guard !session.closed else { throw languageServerError("Language server session exited") }
    if session.runtime == nil {
      let files = LanguageServerFiles(root: args.root)
      guard files.directoryExists(args.root) else { throw languageServerError("Workspace root is not accessible") }
      session.files = files
      session.runtime = try LanguageServerRuntime(kind: args.kind, files: files, directory: LanguageServerRuntime.bundleDirectory,
        schemas: schemas, queue: session.queue)
    }
    guard let runtime = session.runtime else { return }
    let id = UUID()
    let reply = LanguageServerReply(invoke)
    session.pending[id] = reply
    runtime.context.exception = nil
    runtime.context.exceptionHandler = { [weak self, weak session] context, exception in
      context?.exception = exception
      guard let self, let session else { return }
      self.discard(args.sessionId, session: session, message: exception?.toString() ?? "Language server JavaScript failed")
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
    runtime.server.invokeMethod("handle", withArguments: [args.method, args.paramsJson, completion])
    session.queue.asyncAfter(deadline: .now() + 30) { [weak self, weak session, weak reply] in
      guard let self, let session, let reply, !reply.finished else { return }
      self.discard(args.sessionId, session: session, message: "Language server request timed out")
    }
  }

  /// Runs on the session queue.
  private func close(_ session: LanguageServerSession, message: String) {
    session.closed = true
    session.runtime?.dispose()
    session.runtime = nil
    session.files?.close()
    for reply in session.pending.values { reply.reject(message) }
    session.pending.removeAll()
  }

  /// Runs on the session queue.
  private func discard(_ id: String, session: LanguageServerSession, message: String) {
    close(session, message: message)
    queue.async { if self.sessions[id] === session { self.sessions.removeValue(forKey: id) } }
  }
}
