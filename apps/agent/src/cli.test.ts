import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { main, type CliIO } from "./cli.js";
import { sink, tempDir } from "./testing.js";

async function cli(argv: string[], options: { stdin?: string; tty?: boolean } = {}) {
  const home = await tempDir("oxa-home-");
  const stdout = Object.assign(sink(), { isTTY: options.tty });
  const stderr = sink();
  const io: CliIO = { stdin: Readable.from([options.stdin ?? ""]), stdout, stderr, env: { OXBIT_AGENT_HOME: home }, cwd: home };
  const code = await main(argv, io);
  return { code, stdout: stdout.text, stderr: stderr.text, home, io };
}

describe("oxbit-agent CLI", () => {
  it("prints the version and help", async () => {
    expect(await cli(["--version"])).toEqual(expect.objectContaining({ code: 0, stdout: expect.stringMatching(/^oxbit-agent \d+\.\d+\.\d+\n$/) }));
    expect((await cli(["-h"])).stdout).toContain("oxbit-agent acp");
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
    expect(login.code).toBe(0);
    const auth = join(login.home, "auth.json");
    expect(JSON.parse(await readFile(auth, "utf8"))).toEqual({ anthropic: { type: "api", key: "sk-test" } });
    expect((await stat(auth)).mode & 0o777).toBe(0o600);
    const logout = await main(["logout"], login.io);
    expect(logout).toBe(0);
    expect(JSON.parse(await readFile(auth, "utf8"))).toEqual({});
  });

  it("explains that ChatGPT sign-in is not available yet", async () => {
    expect(await cli(["login", "chatgpt"])).toEqual(expect.objectContaining({ code: 1, stderr: expect.stringContaining("Sign in with ChatGPT") }));
  });
});
