import Foundation
import JavaScriptCore

/// Loads each generated bundle the way the app does. Run with JSC_useJIT=0 to match iOS app contexts.
struct Failure: Error { let message: String }

struct Sample {
  let kind: String
  let path: String
  let language: String
  let text: String
  let completion: (line: Int, character: Int, label: String)?
}

let samples = [
  Sample(kind: "typescript", path: "main.ts", language: "typescript", text: "const value: number = \"text\";\nvalue.toFi", completion: (1, 10, "toFixed")),
  Sample(kind: "json", path: "package.json", language: "json", text: "{\"name\": 1, \"version\": \"1.0.0\"}", completion: nil),
  Sample(kind: "yaml", path: ".github/workflows/ci.yml", language: "yaml", text: "on: push\njobs:\n  build:\n    runs-on: 5\n", completion: nil),
  Sample(kind: "dockerfile", path: "Dockerfile", language: "dockerfile", text: "FROM alpine\nEXPOSE abc\nRU", completion: (2, 2, "RUN")),
  Sample(kind: "shell", path: "run.sh", language: "shellscript", text: "#!/bin/bash\ngreet() { echo hi; }\nif then\ngre", completion: (3, 3, "greet")),
  Sample(kind: "shell", path: ".zshrc", language: "zsh", text: "setopt autocd\nalias ll='ls -l'\nfunction greet { echo hi }\nfi\ngre", completion: (4, 3, "greet")),
  Sample(kind: "python", path: "main.py", language: "python", text: "import os\nvalue = 1\nvalue = undefined_name\n", completion: nil),
]

let arguments = CommandLine.arguments
guard arguments.count > 1 else {
  print("Usage: language-server-bundle <bundle directory> [kind...]")
  exit(2)
}
let directory = URL(fileURLWithPath: arguments[1], isDirectory: true)
let only = Set(arguments.dropFirst(2))
let queue = DispatchQueue(label: "com.yannelli.oxbit.language-server-test")
let root = FileManager.default.temporaryDirectory.appendingPathComponent("oxbit-language-bundle-\(UUID().uuidString)")
defer { try? FileManager.default.removeItem(at: root) }
let schemas = SchemaCache(directory: root.appendingPathComponent("cache"), bundled: directory.appendingPathComponent("schemas"),
  fetch: { _, completion in completion(.failure(URLError(.notConnectedToInternet))) })

func send(_ runtime: LanguageServerRuntime, _ method: String, _ params: Any) throws -> [String: Any] {
  let done = DispatchSemaphore(value: 0)
  var payload = ""
  queue.async {
    let completion: @convention(block) (String) -> Void = { value in payload = value; done.signal() }
    let json = String(data: try! JSONSerialization.data(withJSONObject: params, options: [.fragmentsAllowed]), encoding: .utf8)!
    runtime.server.invokeMethod("handle", withArguments: [method, json, completion])
  }
  guard done.wait(timeout: .now() + 60) == .success else { throw Failure(message: "\(method) timed out") }
  let message = try JSONSerialization.jsonObject(with: Data(payload.utf8)) as! [String: Any]
  if let error = message["error"] as? [String: Any] { throw Failure(message: "\(method): \(error["message"] ?? "")") }
  return message
}

func milliseconds(_ start: TimeInterval) -> Int { Int((ProcessInfo.processInfo.systemUptime - start) * 1000) }

var failed = false
for sample in samples where only.isEmpty || only.contains(sample.kind) {
  do {
    let workspace = root.appendingPathComponent(sample.kind + "-" + sample.language)
    let file = workspace.appendingPathComponent(sample.path)
    try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
    try sample.text.write(to: file, atomically: true, encoding: .utf8)
    let files = LanguageServerFiles(root: workspace.path)
    let start = ProcessInfo.processInfo.systemUptime
    var runtime: LanguageServerRuntime!
    var exception: String?
    try queue.sync {
      runtime = try LanguageServerRuntime(kind: sample.kind, files: files, directory: directory, schemas: schemas, queue: queue,
        log: { level, message in if level == "error" { print("  [\(sample.kind) \(level)] \(message.prefix(300))") } })
      runtime.context.exceptionHandler = { _, value in exception = value?.toString() }
    }
    let loaded = milliseconds(start)
    _ = try send(runtime, "initialize", ["initializationOptions": ["settings": ["schemaDownload": false]]])
    let initialized = milliseconds(start)
    let uri = files.root.appendingPathComponent(sample.path).absoluteString
    if ProcessInfo.processInfo.environment["OXBIT_DEBUG"] != nil { print(uri) }
    let opened = try send(runtime, "textDocument/didOpen", ["textDocument": ["uri": uri, "languageId": sample.language, "version": 1, "text": sample.text]])
    let diagnosed = milliseconds(start)
    let notifications = opened["notifications"] as? [[String: Any]] ?? []
    let diagnostics = notifications.compactMap { ($0["params"] as? [String: Any])?["diagnostics"] as? [Any] }.flatMap { $0 }
    var completed = -1
    if let completion = sample.completion {
      let result = try send(runtime, "textDocument/completion", ["textDocument": ["uri": uri], "position": ["line": completion.line, "character": completion.character]])
      completed = milliseconds(start) - diagnosed
      let value = result["result"]
      let items = (value as? [String: Any])?["items"] as? [[String: Any]] ?? value as? [[String: Any]] ?? []
      guard items.contains(where: { $0["label"] as? String == completion.label }) else {
        throw Failure(message: "completion has no \(completion.label) among \(items.count) items")
      }
    }
    if sample.completion == nil && diagnostics.isEmpty { throw Failure(message: "no diagnostics for \(sample.path)") }
    if let exception { throw Failure(message: "uncaught exception: \(exception)") }
    _ = try send(runtime, "exit", NSNull())
    queue.sync { runtime.dispose() }
    print("{\"kind\":\"\(sample.kind)\",\"language\":\"\(sample.language)\",\"loadMs\":\(loaded),\"initializeMs\":\(initialized),\"firstDiagnosticsMs\":\(diagnosed),\"diagnostics\":\(diagnostics.count),\"completionMs\":\(completed)}")
  } catch let failure as Failure {
    print("FAIL \(sample.kind) \(sample.language): \(failure.message)")
    failed = true
  } catch {
    print("FAIL \(sample.kind) \(sample.language): \(error.localizedDescription)")
    failed = true
  }
}
exit(failed ? 1 : 0)
