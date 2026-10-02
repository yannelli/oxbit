import Foundation

final class LanguageServerFiles {
  let root: URL
  private var active = true
  private let maximumReadBytes = 20 * 1024 * 1024

  init(root: String) {
    self.root = URL(fileURLWithPath: root, isDirectory: true)
      .resolvingSymlinksInPath().standardizedFileURL
  }

  func close() {
    active = false
  }

  private func resolve(_ path: String) -> URL? {
    guard active, path.hasPrefix("/"), !path.contains("\0"), !path.contains("\\"),
      !path.split(separator: "/").contains("..")
    else { return nil }
    let url = URL(fileURLWithPath: path).resolvingSymlinksInPath().standardizedFileURL
    let components = root.pathComponents
    guard Array(url.pathComponents.prefix(components.count)) == components else { return nil }
    return url
  }

  func fileExists(_ path: String) -> Bool {
    guard let url = resolve(path) else { return false }
    var directory: ObjCBool = false
    return FileManager.default.fileExists(atPath: url.path, isDirectory: &directory)
      && !directory.boolValue
  }

  func directoryExists(_ path: String) -> Bool {
    guard let url = resolve(path) else { return false }
    var directory: ObjCBool = false
    return FileManager.default.fileExists(atPath: url.path, isDirectory: &directory)
      && directory.boolValue
  }

  private func validUTF16LE(_ data: Data) -> Bool {
    guard data.count.isMultiple(of: 2) else { return false }
    var index = data.startIndex
    while index < data.endIndex {
      let unit = UInt16(data[index]) | UInt16(data[index + 1]) << 8
      if (0xd800...0xdbff).contains(unit) {
        guard index + 3 < data.endIndex else { return false }
        let next = UInt16(data[index + 2]) | UInt16(data[index + 3]) << 8
        guard (0xdc00...0xdfff).contains(next) else { return false }
        index += 4
      } else {
        guard !(0xdc00...0xdfff).contains(unit) else { return false }
        index += 2
      }
    }
    return true
  }

  func readFile(_ path: String) -> String? {
    guard let url = resolve(path),
      let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey]),
      values.isRegularFile == true, let size = values.fileSize, size <= maximumReadBytes,
      let data = try? Data(contentsOf: url), data.count <= maximumReadBytes
    else { return nil }
    let content: Data
    let encoding: String.Encoding
    if data.starts(with: [0xff, 0xfe]) {
      content = Data(data.dropFirst(2))
      guard validUTF16LE(content) else { return nil }
      encoding = .utf16LittleEndian
    } else if data.starts(with: [0xef, 0xbb, 0xbf]) {
      content = Data(data.dropFirst(3))
      encoding = .utf8
    } else {
      guard !data.starts(with: [0xfe, 0xff]) else { return nil }
      content = data
      encoding = .utf8
    }
    guard let text = String(data: content, encoding: encoding), !text.contains("\0") else {
      return nil
    }
    return text.replacingOccurrences(of: "\r\n", with: "\n")
  }

  func list(_ path: String) -> String {
    guard let directory = resolve(path),
      let children = try? FileManager.default.contentsOfDirectory(
        at: directory, includingPropertiesForKeys: nil)
    else { return "[]" }
    let entries: [[String: String]] = children.compactMap { child in
      guard let url = resolve(child.path),
        let values = try? url.resourceValues(forKeys: [.isDirectoryKey, .isRegularFileKey])
      else { return nil }
      let kind: String
      if values.isDirectory == true { kind = "directory" }
      else if values.isRegularFile == true { kind = "file" }
      else { return nil }
      return ["name": child.lastPathComponent, "kind": kind]
    }.sorted { ($0["name"] ?? "") < ($1["name"] ?? "") }
    guard let data = try? JSONSerialization.data(withJSONObject: entries),
      let json = String(data: data, encoding: .utf8)
    else { return "[]" }
    return json
  }
}
