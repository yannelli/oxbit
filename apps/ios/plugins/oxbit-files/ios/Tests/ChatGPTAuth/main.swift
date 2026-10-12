import Foundation

func expect(_ value: @autoclosure () throws -> Bool, _ message: String) throws {
  guard try value() else {
    throw NSError(domain: "ChatGPTAuthTests", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
  }
}

func throwsError(_ operation: () throws -> Void) -> Bool {
  do { try operation() } catch { return true }
  return false
}

func json(_ object: Any) -> Data {
  try! JSONSerialization.data(withJSONObject: object)
}

func jwt(_ claims: [String: Any]) -> String {
  let payload = json(claims).base64EncodedString()
    .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
    .replacingOccurrences(of: "=", with: "")
  return "eyJhbGciOiJub25lIn0.\(payload).signature"
}

func account(_ id: String) -> [String: Any] { ["https://api.openai.com/auth": ["chatgpt_account_id": id]] }

func runTests() throws {
  let now = Date(timeIntervalSince1970: 1_800_000_000)
  let nowMs = ChatGPTAuth.milliseconds(now)

  // JWT account id: base64url payloads of every padding length, and tokens without the claim.
  for id in ["a", "ab", "abc", "acct-1234~?>"] {
    try expect(ChatGPTAuth.accountId(jwt: jwt(account(id))) == id, "reads the account id \(id)")
  }
  try expect(ChatGPTAuth.accountId(jwt: jwt(["sub": "user"])) == nil, "a token without the auth claim has no account")
  try expect(ChatGPTAuth.accountId(jwt: jwt(account(""))) == nil, "an empty account id is no account")
  try expect(ChatGPTAuth.accountId(jwt: "not-a-jwt") == nil, "a malformed token has no account")
  try expect(ChatGPTAuth.accountId(jwt: "a.%%%.c") == nil, "a payload that is not base64 has no account")

  // Refresh decision: 5 minute margin.
  func credential(expiresIn ms: Int) -> ChatGPTAuth.Credential {
    ChatGPTAuth.Credential(access: "a", refresh: "r", idToken: "i", expiresAt: nowMs + ms, accountId: "acct")
  }
  try expect(!ChatGPTAuth.needsRefresh(credential(expiresIn: 6 * 60_000), now: now), "6 minutes left keeps the token")
  try expect(ChatGPTAuth.needsRefresh(credential(expiresIn: 5 * 60_000), now: now), "5 minutes left refreshes")
  try expect(ChatGPTAuth.needsRefresh(credential(expiresIn: 60_000), now: now), "1 minute left refreshes")
  try expect(ChatGPTAuth.needsRefresh(credential(expiresIn: -60_000), now: now), "an expired token refreshes")

  // Poll status mapping.
  try expect(ChatGPTAuth.poll(status: 200, body: json(["authorization_code": "code", "code_challenge": "c",
    "code_verifier": "verifier"])) == .complete(code: "code", verifier: "verifier"), "2xx completes")
  if case .failed = ChatGPTAuth.poll(status: 200, body: json(["authorization_code": "code"])) {} else {
    try expect(false, "2xx without a verifier fails")
  }
  try expect(ChatGPTAuth.poll(status: 403, body: Data()) == .pending, "403 is pending")
  try expect(ChatGPTAuth.poll(status: 404, body: json(["error": "x"])) == .pending, "404 is pending")
  try expect(ChatGPTAuth.poll(status: 400, body: json(["error": "deviceauth_authorization_pending"])) == .pending,
    "a pending error string is pending")
  try expect(ChatGPTAuth.poll(status: 400, body: json(["error": ["code": "deviceauth_authorization_pending"]])) == .pending,
    "a pending error code is pending")
  try expect(ChatGPTAuth.poll(status: 429, body: json(["error": ["code": "slow_down"]])) == .slowDown, "slow_down")
  try expect(ChatGPTAuth.poll(status: 400, body: json(["error": "slow_down"])) == .slowDown, "slow_down string")
  try expect(ChatGPTAuth.poll(status: 500, body: Data("upstream down".utf8))
    == .failed("ChatGPT sign-in failed with status 500: upstream down"), "other answers fail with status and body")
  try expect(ChatGPTAuth.poll(status: 410, body: Data()) == .failed("ChatGPT sign-in failed with status 410"),
    "an empty body fails with the status")

  // Device code answers.
  try expect(try ChatGPTAuth.deviceCode(json(["device_auth_id": "d", "user_code": "U-1", "interval": "5"]))
    == .init(deviceAuthId: "d", userCode: "U-1", interval: 5), "a string interval")
  try expect(try ChatGPTAuth.deviceCode(json(["device_auth_id": "d", "usercode": "U-2", "interval": 0]))
    == .init(deviceAuthId: "d", userCode: "U-2", interval: 1), "usercode alias and an interval floor of 1")
  try expect(try ChatGPTAuth.deviceCode(json(["device_auth_id": "d", "user_code": "U"])).interval == 5,
    "a missing interval is 5")
  try expect(throwsError { _ = try ChatGPTAuth.deviceCode(json(["device_auth_id": "d", "user_code": "U", "interval": "x"])) },
    "an invalid interval is refused")
  try expect(throwsError { _ = try ChatGPTAuth.deviceCode(json(["user_code": "U"])) }, "a missing device id is refused")

  // Token answers: account from the access token, then the ID token; refresh rotation.
  let signedIn = try ChatGPTAuth.credential(json(["access_token": jwt(account("from-access")), "refresh_token": "r1",
    "id_token": jwt(account("from-id")), "expires_in": 3600]), previous: nil, now: now)
  try expect(signedIn.accountId == "from-access" && signedIn.refresh == "r1", "exchange reads the access token account")
  try expect(signedIn.expiresAt == nowMs + 3_600_000, "expires_in sets the expiry")
  let fallback = try ChatGPTAuth.credential(json(["access_token": jwt(["exp": 1_900_000_000]), "refresh_token": "r1",
    "id_token": jwt(account("from-id"))]), previous: nil, now: now)
  try expect(fallback.accountId == "from-id", "the ID token account is the fallback")
  try expect(fallback.expiresAt == 1_900_000_000_000, "the exp claim sets the expiry without expires_in")
  let rotated = try ChatGPTAuth.credential(json(["access_token": jwt(account("from-access")), "refresh_token": "r2",
    "expires_in": 60]), previous: signedIn, now: now)
  try expect(rotated.refresh == "r2" && rotated.idToken == signedIn.idToken, "a new refresh token replaces the old one")
  let kept = try ChatGPTAuth.credential(json(["access_token": jwt([:]), "expires_in": 60]), previous: signedIn, now: now)
  try expect(kept.refresh == "r1" && kept.idToken == signedIn.idToken, "a missing refresh token keeps the old one")
  try expect(kept.accountId == "from-id", "the kept ID token supplies the account")
  try expect(throwsError { _ = try ChatGPTAuth.credential(json(["access_token": jwt(account("a"))]), previous: nil, now: now) },
    "an exchange without a refresh token is refused")
  try expect(throwsError { _ = try ChatGPTAuth.credential(json(["access_token": jwt([:]), "refresh_token": "r"]),
    previous: nil, now: now) }, "a sign-in without an account is refused")

  // Requests.
  let refresh = ChatGPTAuth.refreshRequest("a+b/c=&d")
  try expect(refresh.url?.absoluteString == "https://auth.openai.com/oauth/token", "refresh posts to the token URL")
  try expect(String(decoding: refresh.httpBody ?? Data(), as: UTF8.self)
    == "grant_type=refresh_token&refresh_token=a%2Bb%2Fc%3D%26d&client_id=app_EMoamEEZ73f0CkXaXp7hrann",
    "refresh form-encodes its fields")
  let poll = ChatGPTAuth.pollRequest(deviceAuthId: "d", userCode: "U")
  try expect(poll.url?.absoluteString == "https://auth.openai.com/api/accounts/deviceauth/token", "poll URL")
  try expect((try JSONSerialization.jsonObject(with: poll.httpBody ?? Data()) as? [String: String])
    == ["device_auth_id": "d", "user_code": "U"], "poll sends the device id and user code")

  // Endpoint: fixed base, query on the models path, and headers.
  let endpoint = try AgentModelEndpoint(api: "chatgpt", baseUrl: "https://example.com")
  try expect(endpoint.account == "chatgpt https://chatgpt.com", "the Keychain account ignores baseUrl")
  try expect(try endpoint.url("/codex/models?client_version=0.1.0").absoluteString
    == "https://chatgpt.com/backend-api/codex/models?client_version=0.1.0", "the models path keeps its query")
  try expect(try endpoint.url("/codex/responses").absoluteString == "https://chatgpt.com/backend-api/codex/responses",
    "the responses path")
  for path in ["/codex/../me", "//evil.com/x", "/codex#x", "/codex/%2e%2e/me"] {
    try expect(throwsError { _ = try endpoint.url(path) }, "\(path) is refused")
  }
  var request = URLRequest(url: try endpoint.url("/codex/responses"))
  request.httpMethod = "POST"
  AgentModelEndpoint.authorize(&request, chatgpt: signedIn)
  try expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer \(signedIn.access)", "bearer access token")
  try expect(request.value(forHTTPHeaderField: "chatgpt-account-id") == "from-access", "account header")
  try expect(request.value(forHTTPHeaderField: "OpenAI-Beta") == "responses=experimental", "beta header")
  try expect(request.value(forHTTPHeaderField: "originator") == "oxbit", "originator header")
  try expect(request.value(forHTTPHeaderField: "Accept") == "text/event-stream", "POST accepts SSE")
  var get = URLRequest(url: try endpoint.url("/codex/models?client_version=0.1.0"))
  AgentModelEndpoint.authorize(&get, chatgpt: signedIn)
  try expect(get.value(forHTTPHeaderField: "Accept") == nil, "GET leaves Accept unset")
}

do {
  try runTests()
  print("ChatGPTAuth tests passed")
} catch {
  FileHandle.standardError.write(Data("\(error.localizedDescription)\n".utf8))
  exit(1)
}
