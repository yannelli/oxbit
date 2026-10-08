import Foundation

func expect(_ value: @autoclosure () -> Bool, _ message: String) throws {
  guard value() else {
    throw NSError(domain: "GitCredentialProfileTests", code: 1,
      userInfo: [NSLocalizedDescriptionKey: message])
  }
}

func ids() -> () -> String {
  var next = 0
  return {
    next += 1
    return "00000000-0000-0000-0000-00000000000\(next)"
  }
}

func decode(_ json: String) throws -> GitCredentialProfile {
  try JSONDecoder().decode(GitCredentialProfile.self, from: Data(json.utf8))
}

func account(_ login: String, host: String = "github.com", token: String) -> GitAccountRecord {
  GitAccountRecord(id: UUID().uuidString, provider: host == "github.com" ? "github" : "gitea", host: host,
    url: host == "github.com" ? nil : "https://\(host)", login: login, token: token, isDefault: false)
}

func runTests() throws {
  var legacy = try decode("""
    {"token":"github-fixture","login":"octocat","name":"Example Author","email":"author@example.com",
     "gitea":{"url":"https://git.example.test/gitea","host":"git.example.test:3000","token":"gitea-fixture","login":"gitea.user"}}
    """)
  try expect(legacy.migrate(makeID: ids()), "Legacy credentials migrate")
  try expect(legacy.token == nil && legacy.login == nil && legacy.gitea == nil, "Migration clears legacy fields")
  try expect(legacy.name == "Example Author" && legacy.email == "author@example.com", "Migration keeps the author")
  try expect(legacy.accountList == [
    GitAccountRecord(id: "00000000-0000-0000-0000-000000000001", provider: "github", host: "github.com", url: nil,
      login: "octocat", token: "github-fixture", isDefault: true),
    GitAccountRecord(id: "00000000-0000-0000-0000-000000000002", provider: "gitea", host: "git.example.test:3000",
      url: "https://git.example.test/gitea", login: "gitea.user", token: "gitea-fixture", isDefault: true),
  ], "Migration keeps both tokens as host defaults")
  try expect(legacy.hasConsistentAccounts, "Migrated accounts are consistent")
  let saved = try JSONDecoder().decode(GitCredentialProfile.self, from: JSONEncoder().encode(legacy))
  try expect(saved == legacy, "Migrated profile round-trips")
  var again = saved
  try expect(!again.migrate(makeID: ids()) && again == saved, "Migration runs once")
  let keys = try JSONSerialization.jsonObject(with: JSONEncoder().encode(legacy)) as? [String: Any]
  try expect(Set(keys?.keys.map { $0 } ?? []) == ["name", "email", "accounts"], "Legacy keys are not written")

  var githubOnly = try decode(#"{"token":"github-fixture","login":"octocat"}"#)
  try expect(githubOnly.migrate(makeID: ids()) && githubOnly.accountList.count == 1
    && githubOnly.accountList[0].isDefault, "GitHub-only credentials migrate")
  var giteaOnly = try decode(#"{"name":"A","gitea":{"url":"https://git.example.test","host":"git.example.test","token":"t","login":"u"}}"#)
  try expect(giteaOnly.migrate(makeID: ids()) && giteaOnly.accountList.map(\.provider) == ["gitea"], "Gitea-only credentials migrate")
  var authorOnly = try decode(#"{"name":"A","email":"a@example.test"}"#)
  try expect(!authorOnly.migrate(makeID: ids()) && authorOnly.accounts == nil, "Author-only profiles stay unchanged")

  var profile = GitCredentialProfile()
  let first = profile.add(account("octocat", token: "one"))
  let second = profile.add(account("hubot", token: "two"))
  let gitea = profile.add(account("gitea.user", host: "git.example.test", token: "three"))
  try expect(first.isDefault && !second.isDefault && gitea.isDefault, "First account per host is the default")
  try expect(profile.hasConsistentAccounts, "Two GitHub accounts are consistent")
  let replaced = profile.add(account("OctoCat", token: "rotated"))
  try expect(replaced.id == first.id && replaced.isDefault && replaced.token == "rotated"
    && profile.accountList.count == 3, "Adding a known login replaces its token")
  try expect(profile.setDefault(id: second.id), "Make default")
  try expect(profile.accountList.filter(\.isDefault).map(\.id) == [second.id, gitea.id], "One default per host")
  try expect(!profile.setDefault(id: "missing"), "Unknown default is rejected")
  try expect(profile.remove(id: second.id), "Remove default")
  try expect(profile.accountList.first { $0.id == first.id }?.isDefault == true, "Removing a default promotes the next account")
  try expect(profile.remove(id: gitea.id) && profile.accountList.map(\.id) == [first.id], "Remove the only Gitea account")
  try expect(!profile.remove(id: gitea.id), "Unknown removal is rejected")

  var inconsistent = profile
  inconsistent.accounts?[0].isDefault = false
  try expect(!inconsistent.hasConsistentAccounts, "A host without a default is inconsistent")
  inconsistent.accounts = [first, first]
  try expect(!inconsistent.hasConsistentAccounts, "Duplicate IDs are inconsistent")
}

do {
  try runTests()
  print("GitCredentialProfile tests passed")
} catch {
  FileHandle.standardError.write(Data("\(error.localizedDescription)\n".utf8))
  exit(1)
}
