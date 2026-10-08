import Foundation

struct GitAccountRecord: Codable, Equatable {
  var id: String
  var provider: String
  var host: String
  var url: String?
  var login: String
  var token: String
  var isDefault: Bool
}

struct LegacyGiteaProfile: Codable, Equatable {
  var url: String
  var host: String
  var token: String
  var login: String
}

/// The Keychain profile. `token`, `login`, and `gitea` hold the single GitHub and Gitea
/// credentials saved before multiple accounts; `migrate` moves them into `accounts`.
struct GitCredentialProfile: Codable, Equatable {
  static let maximumAccounts = 12

  var name: String?
  var email: String?
  var accounts: [GitAccountRecord]?
  var token: String?
  var login: String?
  var gitea: LegacyGiteaProfile?

  var accountList: [GitAccountRecord] { accounts ?? [] }

  mutating func migrate(makeID: () -> String = { UUID().uuidString }) -> Bool {
    guard token != nil || login != nil || gitea != nil else { return false }
    var list = accountList
    if let token, let login {
      list.append(GitAccountRecord(id: makeID(), provider: "github", host: "github.com", url: nil,
        login: login, token: token, isDefault: !list.contains { $0.host == "github.com" && $0.isDefault }))
    }
    if let gitea {
      list.append(GitAccountRecord(id: makeID(), provider: "gitea", host: gitea.host, url: gitea.url,
        login: gitea.login, token: gitea.token, isDefault: !list.contains { $0.host == gitea.host && $0.isDefault }))
    }
    accounts = list
    token = nil
    login = nil
    gitea = nil
    return true
  }

  /// Replaces the token of an account with the same provider, host, and login, keeping its ID
  /// and default state; otherwise appends the account, as the default when its host has none.
  mutating func add(_ account: GitAccountRecord) -> GitAccountRecord {
    var list = accountList
    if let index = list.firstIndex(where: {
      $0.provider == account.provider && $0.host == account.host
        && $0.login.caseInsensitiveCompare(account.login) == .orderedSame
    }) {
      list[index].token = account.token
      list[index].url = account.url
      list[index].login = account.login
      accounts = list
      return list[index]
    }
    var added = account
    added.isDefault = !list.contains { $0.host == account.host && $0.isDefault }
    list.append(added)
    accounts = list
    return added
  }

  mutating func remove(id: String) -> Bool {
    var list = accountList
    guard let index = list.firstIndex(where: { $0.id == id }) else { return false }
    let removed = list.remove(at: index)
    if removed.isDefault, let next = list.firstIndex(where: { $0.host == removed.host }) {
      list[next].isDefault = true
    }
    accounts = list
    return true
  }

  mutating func setDefault(id: String) -> Bool {
    guard let host = accountList.first(where: { $0.id == id })?.host else { return false }
    accounts = accountList.map { account in
      var account = account
      if account.host == host { account.isDefault = account.id == id }
      return account
    }
    return true
  }

  /// Each host with accounts has exactly one default, and IDs are unique.
  var hasConsistentAccounts: Bool {
    let list = accountList
    guard Set(list.map(\.id)).count == list.count, list.count <= Self.maximumAccounts else { return false }
    return Set(list.map(\.host)).allSatisfy { host in
      list.filter { $0.host == host && $0.isDefault }.count == 1
    }
  }
}
