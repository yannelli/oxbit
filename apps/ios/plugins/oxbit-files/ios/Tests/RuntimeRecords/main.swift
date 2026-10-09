import Foundation

struct Failure: LocalizedError {
  let errorDescription: String?
}

func expect(_ value: @autoclosure () -> Bool, _ message: String) throws {
  guard value() else { throw Failure(errorDescription: message) }
}

func runTests() throws {
  try expect(RuntimeIdentity.validId("runtime-0123"), "Accepts letters, digits, and dashes")
  try expect(!RuntimeIdentity.validId("short"), "Rejects ids under 8 characters")
  try expect(!RuntimeIdentity.validId(String(repeating: "a", count: 65)), "Rejects ids over 64 characters")
  try expect(!RuntimeIdentity.validId("runtime:0123"), "Rejects separators")
  try expect(!RuntimeIdentity.validId("runtimé-0123"), "Rejects non-ASCII letters")

  let json = try JSONSerialization.jsonObject(with: Data(
    #"{"ok":true,"protocol":1,"id":"runtime-0123","name":"mac","version":"0.5.0","startedAt":1760000000000}"#.utf8))
  try expect(RuntimeIdentity(json: json) == RuntimeIdentity(id: "runtime-0123", name: "mac", version: "0.5.0",
    startedAt: 1_760_000_000_000), "Reads the identity from a health body")
  try expect(RuntimeIdentity(json: ["id": "bad", "name": "mac", "version": "1", "startedAt": 1]) == nil,
    "Rejects an invalid id")
  try expect(RuntimeIdentity(json: ["id": "runtime-0123", "name": "mac"]) == nil, "Rejects a partial identity")

  try expect(RuntimeAccount.id("runtime-0123") == "runtime-id:runtime-0123", "Id account")
  let origin = RuntimeAccount.origin("http://192.168.1.10:9277/")
  try expect(origin.map(RuntimeAccount.url) == "http://192.168.1.10:9277", "URL account drops the trailing slash")
  try expect(RuntimeAccount.origin("https://runtime.example.test").map(RuntimeAccount.url)
    == "https://runtime.example.test", "HTTPS origin")
  for invalid in ["ftp://host", "http://", "http://user:pw@host", "http://host/path", "http://host?q=1", "http://host#x"] {
    try expect(RuntimeAccount.origin(invalid) == nil, "Rejects \(invalid)")
  }

  let txt = ["id": "runtime-0123", "name": "mac", "version": "0.5.0", "port": "9277"]
  let v4 = DiscoveredRuntime(txt: txt, service: "Oxbit on mac", host: "192.168.1.10", port: 9277)
  try expect(v4?.url == "http://192.168.1.10:9277" && v4?.name == "mac" && v4?.version == "0.5.0", "IPv4 runtime")
  let v6 = DiscoveredRuntime(txt: txt, service: "Oxbit on mac", host: "fe80::1%en0", port: 9277)
  try expect(v6?.host == "fe80::1" && v6?.url == "http://[fe80::1]:9277", "IPv6 drops the scope and gets brackets")
  try expect(DiscoveredRuntime(txt: txt, service: "s", host: "10.0.0.2", port: nil)?.port == 9277,
    "Falls back to the TXT port")
  try expect(DiscoveredRuntime(txt: txt, service: "s", host: "10.0.0.2", port: 4000)?.port == 4000,
    "Resolved port wins over TXT")
  try expect(DiscoveredRuntime(txt: ["name": "mac"], service: "s", host: "10.0.0.2", port: 1) == nil,
    "Drops entries without a TXT id")
  try expect(DiscoveredRuntime(txt: ["id": "runtime-0123"], service: "Oxbit", host: "10.0.0.2", port: 1)?.name
    == "Oxbit" && DiscoveredRuntime(txt: ["id": "runtime-0123"], service: "Oxbit", host: "10.0.0.2", port: 1)?.version
    == nil, "Missing name uses the service name")

  let other = DiscoveredRuntime(txt: ["id": "runtime-4567", "name": "aaa"], service: "s", host: "10.0.0.3", port: 1)!
  let unique = DiscoveredRuntime.unique([v6!, other, v4!])
  try expect(unique.map(\.runtimeId) == ["runtime-4567", "runtime-0123"], "One entry per id, ordered by name")
  try expect(unique[1].host == "192.168.1.10", "IPv4 replaces IPv6 for the same id")
  try expect(DiscoveredRuntime.unique([v4!, v6!])[0].host == "192.168.1.10", "IPv4 is kept over a later IPv6")
}

do {
  try runTests()
  print("RuntimeRecords tests passed")
} catch {
  FileHandle.standardError.write(Data("\(error.localizedDescription)\n".utf8))
  exit(1)
}
