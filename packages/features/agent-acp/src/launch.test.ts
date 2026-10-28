import { describe, expect, it } from "vitest";
import {
  agentErrorText,
  agentName,
  CLAUDE_SIGNED_OUT,
  formatArgs,
  parseArgs,
  rememberAgentName,
  rememberRegistryName,
  resolveLaunch,
  runtimeSupportError,
  startable,
  storedArgs,
} from "./launch.js";
import { providerFor } from "./controller.js";

const config = (values: Record<string, string>) => ({
  get: <T,>(id: string) => values[id] as T | undefined,
});

describe("agent arguments", () => {
  it("splits on whitespace and keeps quoted spaces", () => {
    expect(parseArgs("  acp  --model 'gpt five' \"two words\"  ")).toEqual([
      "acp",
      "--model",
      "gpt five",
      "two words",
    ]);
    expect(parseArgs("")).toEqual([]);
    expect(parseArgs('""')).toEqual([""]);
    expect(parseArgs('say \\"hi\\" a\\ b')).toEqual(["say", '"hi"', "a b"]);
    expect(parseArgs("'C:\\path'")).toEqual(["C:\\path"]);
  });
  it("rejects an unclosed quote", () => {
    expect(() => parseArgs('--name "open')).toThrow("Close the quote");
  });
  it("round-trips through the display format", () => {
    for (const args of [
      ["-y", "@agentclientprotocol/codex-acp@2.2.2"],
      ["/tmp/my agent/run.mjs", "--history"],
      ['quote"inside', "back\\slash", ""],
    ])
      expect(parseArgs(formatArgs(args))).toEqual(args);
    expect(formatArgs(["acp", "two words"])).toBe('acp "two words"');
  });
  it("reads stored JSON arrays of strings only", () => {
    expect(storedArgs('["acp"]')).toEqual(["acp"]);
    expect(storedArgs("[1]")).toBeUndefined();
    expect(storedArgs("not json")).toBeUndefined();
    expect(storedArgs(undefined)).toBeUndefined();
  });
});

describe("agent naming", () => {
  it("prefers the connection name, then the preset, registry, and ID", () => {
    expect(agentName("claude", { provider: "claude", name: "Claude Code" })).toBe("Claude Code");
    expect(agentName("claude")).toBe("Claude");
    expect(agentName("unknown-agent")).toBe("unknown-agent");
    rememberRegistryName("opencode", "OpenCode");
    expect(agentName("opencode")).toBe("OpenCode");
    rememberAgentName("opencode", "OpenCode 1.18");
    expect(agentName("opencode")).toBe("OpenCode 1.18");
    rememberAgentName("codex", "codex-acp 2.2.2");
    expect(agentName("codex")).toBe("Codex");
  });
  it("keeps unknown providers on their own ID", () => {
    expect(providerFor("not-a-preset").name).toBe("not-a-preset");
    expect(providerFor("codex").name).toBe("Codex");
  });
});

describe("launch resolution", () => {
  it("fills built-in presets from settings", () => {
    expect(
      resolveLaunch(
        { provider: "codex" },
        config({ "agentACP.codex.command": "node", "agentACP.codex.args": '["agent.mjs"]' }),
      ),
    ).toEqual({ provider: "codex", command: "node", args: ["agent.mjs"] });
    expect(resolveLaunch({ provider: "gemini" }, config({}))).toEqual({
      provider: "gemini",
      command: "npx",
      args: ["-y", "@google/gemini-cli@0.63.0", "--acp"],
    });
  });
  it("launches registry agents by ID and custom agents from settings", () => {
    expect(resolveLaunch({ provider: "opencode" }, config({}))).toEqual({
      provider: "opencode",
      registry: { id: "opencode" },
    });
    expect(
      resolveLaunch(
        { provider: "custom" },
        config({
          "agentACP.custom.name": "Mine",
          "agentACP.custom.command": "/bin/agent",
          "agentACP.custom.args": '["--acp","two words"]',
        }),
      ),
    ).toEqual({ provider: "custom", name: "Mine", command: "/bin/agent", args: ["--acp", "two words"] });
  });
  it("launches the Oxbit agent by provider only", () => {
    expect(resolveLaunch({ provider: "oxbit", registry: { id: "oxbit" } }, config({}))).toEqual({ provider: "oxbit" });
    expect(agentName("oxbit")).toBe("Oxbit Agent");
  });
  it("starts the Oxbit agent only without a runtime workspace", () => {
    expect(startable("oxbit", true)).toBe(true);
    for (const provider of ["codex", "opencode", "custom"]) {
      expect(startable(provider, true)).toBe(false);
      expect(startable(provider, false)).toBe(true);
    }
    expect(startable("oxbit", false)).toBe(false);
  });
  it("maps the old runtime provider error", () => {
    const mapped = runtimeSupportError(new Error("Choose Codex, Cursor, or Amp"), "OpenCode");
    expect((mapped as Error).message).toBe(
      "This runtime does not support OpenCode. Update Oxbit on the runtime host.",
    );
    const other = new Error("spawn ENOENT");
    expect(runtimeSupportError(other, "OpenCode")).toBe(other);
  });
  it("maps Claude Agent's -32000 auth error to the runtime sign-in step", () => {
    const signedOut = Object.assign(new Error("Authentication required"), { code: "-32000" });
    expect(agentErrorText("claude", signedOut)).toBe(CLAUDE_SIGNED_OUT);
    expect(agentErrorText("claude", Object.assign(new Error("Authentication required"), { code: -32000 }))).toBe(CLAUDE_SIGNED_OUT);
    expect(agentErrorText("claude", "Authentication required")).toBe(CLAUDE_SIGNED_OUT);
    expect(agentErrorText("codex", signedOut)).toBe("Authentication required");
    expect(agentErrorText("claude", Object.assign(new Error("Internal error"), { code: "-32000" }))).toBe("Internal error");
    expect(agentErrorText("claude", Object.assign(new Error("Authentication required"), { code: "-32603" }))).toBe("Authentication required");
    expect(agentErrorText("claude", "Rate limited")).toBe("Rate limited");
  });
});
