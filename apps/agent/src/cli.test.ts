import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { main, type CliIO } from "./cli.js";
import { sink, tempDir } from "./testing.js";

async function cli(argv: string[], options: { stdin?: string | Readable; tty?: boolean; home?: string } & Pick<CliIO, "fetch" | "open"> = {}) {
  const home = options.home ?? await tempDir("oxa-home-");
  const stdout = Object.assign(sink(), { isTTY: options.tty });
  const stderr = sink();
  const stdin = typeof options.stdin === "object" ? options.stdin : Readable.from([options.stdin ?? ""]);
  const io: CliIO = { stdin, stdout, stderr, env: { OXBIT_AGENT_HOME: home }, cwd: home, fetch: options.fetch, open: options.open };
  const code = await main(argv, io);
  return { code, stdout: stdout.text, stderr: stderr.text, home, io };
}
const signedIn = { ext_agent_host_id: "urn:uuid:1", active: "oaiapp_1", accounts: [{ client_id: "oaiapp_1", issuer: "https://auth.openai.com", subject: "s",
  access_token: "access-secret", refresh_token: "refresh-secret", id_token: "id-secret", scopes: ["chatgpt.tokens.use.direct"], saved_at: "" }] };

describe("oxbit-agent CLI", () => {
  it("prints the version and help", async () => {
    expect(await cli(["--version"])).toEqual(expect.objectContaining({ code: 0, stdout: expect.stringMatching(/^oxbit-agent \d+\.\d+\.\d+\n$/) }));
    expect((await cli(["-h"])).stdout).toContain("oxbit-agent acp");
  });

  it("logs unhandled rejections while serving ACP and removes the handler when the client closes", async () => {
    const before = process.listeners("unhandledRejection");
    const home = await tempDir("oxa-home-");
    const stdin = new PassThrough();
    const stderr = sink();
    const run = main(["acp", "--provider", "ollama"], { stdin, stdout: new PassThrough(), stderr, env: { OXBIT_AGENT_HOME: home }, cwd: home });
    await vi.waitFor(() => expect(process.listeners("unhandledRejection")).toHaveLength(before.length + 1));
    process.listeners("unhandledRejection").find((listener) => !before.includes(listener))!(new Error("Title request failed"), Promise.resolve());
    stdin.end();
    expect(await run).toBe(0);
    expect(stderr.text).toContain("oxbit-agent: Unhandled rejection: Error: Title request failed");
    expect(process.listeners("unhandledRejection")).toEqual(before);
  });

  it("exits 2 for bad arguments and for a non-terminal stdout without -p", async () => {
    expect((await cli(["--nope"])).code).toBe(2);
    expect(await cli(["--mode", "yolo", "-p", "x"])).toEqual(expect.objectContaining({ code: 2, stderr: "oxbit-agent: Unknown mode yolo\n" }));
    expect(await cli([])).toEqual(expect.objectContaining({ code: 2, stderr: expect.stringContaining("stdout is not a terminal") }));
    expect(await cli(["-c", "-r", "x", "-p", "hi"])).toEqual(expect.objectContaining({ code: 2, stderr: expect.stringContaining("not both") }));
    expect(await cli(["-r", "missing", "-p", "hi"])).toEqual(expect.objectContaining({ code: 1, stderr: "oxbit-agent: No saved session missing\n" }));
  });

  it("saves a key from stdin with mode 0600 and removes it on logout", async () => {
    const login = await cli(["login", "--provider", "anthropic"], { stdin: "sk-test\n" });
    expect(login).toMatchObject({ code: 0, stdout: `Saved the Anthropic API key in ${join(login.home, "auth.json")}\n` });
    const auth = join(login.home, "auth.json");
    expect(JSON.parse(await readFile(auth, "utf8"))).toEqual({ "apikey:anthropic": "sk-test" });
    expect((await stat(auth)).mode & 0o777).toBe(0o600);
    expect((await cli(["login", "--provider", "ollama"], { home: login.home })).stderr).toBe("oxbit-agent: Ollama does not use an API key\n");
    const logout = await cli(["logout"], { home: login.home });
    expect(logout).toMatchObject({ code: 0, stdout: "Removed anthropic\n" });
    expect(JSON.parse(await readFile(auth, "utf8"))).toEqual({});
  });

  it("lists the sign-in methods for a plain login", async () => {
    const listed = await cli(["login"]);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toMatch(/OpenAI +Continue with ChatGPT +oxbit-agent login chatgpt\n +Use your ChatGPT plan\n/);
    expect(listed.stdout).toMatch(/Anthropic +Anthropic API key +oxbit-agent login --provider anthropic\n/);
    expect(listed.stdout).toMatch(/Ollama +Local Ollama, no key +no sign-in needed\n/);
  });

  it("lists models with context windows using a legacy auth.json key", async () => {
    const home = await tempDir("oxa-home-");
    await writeFile(join(home, "auth.json"), JSON.stringify({ anthropic: { type: "api", key: "sk-legacy" } }));
    const fetch = vi.fn(async () => Response.json({ data: [{ id: "claude-opus-5-5", display_name: "Claude Opus 5.5" }] }));
    const listed = await cli(["models", "--provider", "anthropic", "--model", "claude-opus-5-5"], { home, fetch });
    expect(listed).toMatchObject({ code: 0, stdout: "* claude-opus-5-5  1,000,000 tokens\n", stderr: "Anthropic\n" });
    expect(fetch).toHaveBeenCalledWith("https://api.anthropic.com/v1/models", expect.objectContaining({ headers: expect.objectContaining({ "x-api-key": "sk-legacy" }) }));
    expect(await cli(["models", "--provider", "openai"], { home })).toMatchObject({ code: 1, stderr: expect.stringContaining("No API key for openai") });
  });

  it("signs out of ChatGPT and revokes the refresh token without printing tokens", async () => {
    const home = await tempDir("oxa-home-");
    await writeFile(join(home, "auth.json"), JSON.stringify({ chatgpt: JSON.stringify(signedIn), "apikey:openai": "sk-o" }));
    const fetch = vi.fn(async () => new Response(null, { status: 200 }));
    const out = await cli(["logout", "chatgpt"], { home, fetch });
    expect(out).toMatchObject({ code: 0, stdout: "Removed ChatGPT\n", stderr: "" });
    expect(fetch).toHaveBeenCalledWith("https://auth.openai.com/api/accounts/oauth/revoke", expect.objectContaining({ method: "POST" }));
    const saved = JSON.parse(await readFile(join(home, "auth.json"), "utf8"));
    expect(saved["apikey:openai"]).toBe("sk-o");
    expect(saved.chatgpt).not.toMatch(/secret/);
    expect(JSON.parse(saved.chatgpt)).toMatchObject({ ext_agent_host_id: "urn:uuid:1", accounts: [{ client_id: "oaiapp_1" }] });
  });

  it("prints the ChatGPT sign-in page and reads a pasted callback when no browser opens", async () => {
    const stdin = new PassThrough();
    let opened = "";
    const signIn = await cli(["login", "chatgpt"], { stdin, open: async (url) => {
      opened = url;
      const query = new URL(url).searchParams;
      stdin.write(`${query.get("redirect_uri")}?error=access_denied&state=${query.get("state")}\n`);
      return false;
    } });
    const query = new URL(opened).searchParams;
    expect(query.get("client_id")).toBe("dynamic_agent_client");
    expect(query.get("agent_name_hint")).toBe("Oxbit Agent");
    expect(query.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
    expect(signIn.stderr).toContain(`Continue with ChatGPT\nOpen this page to sign in:\n${opened}\nNo browser opened.`);
    expect(signIn).toMatchObject({ code: 1, stderr: expect.stringContaining("The ChatGPT sign-in was declined") });
  });
});
