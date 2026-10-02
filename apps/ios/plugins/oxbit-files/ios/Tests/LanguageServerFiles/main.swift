import Foundation

func expect(_ value: @autoclosure () -> Bool, _ message: String) throws {
  guard value() else {
    throw NSError(domain: "LanguageServerFilesTests", code: 1,
      userInfo: [NSLocalizedDescriptionKey: message])
  }
}

func runTests() throws {
  let manager = FileManager.default
  let temporary = manager.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  defer { try? manager.removeItem(at: temporary) }
  let root = temporary.appendingPathComponent("workspace", isDirectory: true)
  let outside = temporary.appendingPathComponent("workspace-other", isDirectory: true)
  try manager.createDirectory(at: root, withIntermediateDirectories: true)
  try manager.createDirectory(at: outside, withIntermediateDirectories: true)
  try manager.createDirectory(at: root.appendingPathComponent("src"), withIntermediateDirectories: true)
  let files = LanguageServerFiles(root: root.path)

  let source = root.appendingPathComponent("source.ts")
  try Data("naïve\r\nsource".utf8).write(to: source)
  try expect(files.readFile(source.path) == "naïve\nsource", "UTF-8 and CRLF decoding")
  try expect(files.fileExists(source.path), "File existence")
  try expect(!files.directoryExists(source.path), "Files are not directories")
  try expect(files.directoryExists(root.path), "Root directory existence")
  try expect(!files.fileExists(root.path), "Directories are not files")

  let utf8 = root.appendingPathComponent("bom.ts")
  var utf8Bytes = Data([0xef, 0xbb, 0xbf])
  utf8Bytes.append(contentsOf: "export const café = 1;".utf8)
  try utf8Bytes.write(to: utf8)
  try expect(files.readFile(utf8.path) == "export const café = 1;", "UTF-8 BOM decoding")
  let utf16 = root.appendingPathComponent("utf16.ts")
  try Data([0xff, 0xfe, 0x41, 0, 0x0d, 0, 0x0a, 0, 0x3d, 0xd8, 0, 0xde]).write(to: utf16)
  try expect(files.readFile(utf16.path) == "A\n😀", "UTF-16LE BOM decoding")
  let invalidInputs: [[UInt8]] = [[0xc0, 0xaf], [0xfe, 0xff, 0, 0x41], [0xff, 0xfe, 0x41],
    [0xff, 0xfe, 0, 0xd8], [0xff, 0xfe, 0, 0xdc], [0x41, 0]]
  for bytes in invalidInputs {
    let invalid = root.appendingPathComponent("invalid.ts")
    try Data(bytes).write(to: invalid)
    try expect(files.readFile(invalid.path) == nil, "Invalid or binary text is unavailable")
  }

  let secret = outside.appendingPathComponent("secret.ts")
  try Data("outside".utf8).write(to: secret)
  try manager.createSymbolicLink(at: root.appendingPathComponent("escape"), withDestinationURL: outside)
  try manager.createSymbolicLink(at: root.appendingPathComponent("escape.ts"), withDestinationURL: secret)
  let insideLink = root.appendingPathComponent("inside.ts")
  try manager.createSymbolicLink(at: insideLink, withDestinationURL: source)
  try expect(files.readFile(insideLink.path) == "naïve\nsource", "Symlinks within the root")
  for path in [secret.path, root.path + "/escape.ts", root.path + "/escape/secret.ts",
    root.path + "/../workspace-other/secret.ts", "source.ts", source.path + "\0"] {
    try expect(files.readFile(path) == nil, "Escaped read denied: \(path)")
    try expect(!files.fileExists(path), "Escaped file lookup denied: \(path)")
  }
  for path in [outside.path, root.path + "/escape", root.path + "/../workspace-other"] {
    try expect(!files.directoryExists(path), "Escaped directory lookup denied")
    try expect(files.list(path) == "[]", "Escaped directory listing denied")
  }
  let entries = try JSONSerialization.jsonObject(with: Data(files.list(root.path).utf8))
    as! [[String: String]]
  try expect(entries.contains(["name": "source.ts", "kind": "file"]), "Lists files")
  try expect(entries.contains(["name": "src", "kind": "directory"]), "Lists directories")
  try expect(!entries.contains { $0["name"]?.hasPrefix("escape") == true }, "Skips escaped symlinks")
  let missing = root.appendingPathComponent("missing.ts").path
  try expect(files.readFile(missing) == nil, "Missing files are unavailable")
  try expect(!files.fileExists(missing), "Missing files do not exist")
  try expect(files.list(root.appendingPathComponent("missing").path) == "[]", "Missing directories")

  files.close()
  try expect(files.readFile(source.path) == nil, "Closed roots reject reads")
  try expect(!files.fileExists(source.path), "Closed roots reject file lookup")
  try expect(!files.directoryExists(root.path), "Closed roots reject directory lookup")
  try expect(files.list(root.path) == "[]", "Closed roots reject listings")
  print("LanguageServerFiles checks passed")
}

do {
  try runTests()
} catch {
  FileHandle.standardError.write(Data((error.localizedDescription + "\n").utf8))
  exit(1)
}
