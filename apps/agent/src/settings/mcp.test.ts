import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chatText } from "@oxbit/agent-core/test-models";
import { FileAuthStore } from "../auth.js";
import { MemoryConnection } from "../connection.js";
import { echoServer, panelContext, testSetup } from "../testing.js";
import { createSettingsManager } from "./index.js";
import { splitCommandLine } from "./mcp.js";

const managerFor = (t: Awaited<ReturnType<typeof testSetup>>) =>
  createSettingsManager({ config: t.config, auth: new FileAuthStore(t.config.paths.auth), env: {}, home: t.home, provider: () => t.setup.provider });

describe("mcp panel", () => {
  it("splits command lines with quotes and backslashes", () => {
    expect(splitCommandLine(`npx -y "@scope/server" --root 'my dir' a\\ b "say \\"hi\\"" ''`)).toEqual(["npx", "-y", "@scope/server", "--root", "my dir", "a b", "say \"hi\"", ""]);
    expect(() => splitCommandLine("run 'open")).toThrow("unclosed quote");
  });

  it("adds, turns off and removes servers in mcp.json and keeps the rest of the file", async () => {
    const t = await testSetup([]);
    const manager = managerFor(t);
    const context = panelContext(t.root);
    const file = async () => JSON.parse(await readFile(t.config.paths.mcp, "utf8"));
    await writeFile(t.config.paths.mcp, JSON.stringify({ note: 1, mcpServers: { keep: { type: "http", url: "https://keep.example.com/mcp" } } }));
    await writeFile(join(t.root, ".mcp.json"), JSON.stringify({ mcpServers: { local: { command: "./server", disabled: true } } }));
    expect(await manager.act("mcp", "add", "add", ["docs", "https://docs.example.com/mcp"], context)).toEqual({ message: "Added docs; it connects on the next turn" });
    await manager.act("mcp", "add", "add", ["files", "npx -y '@scope/files' --root \"my dir\""], context);
    await expect(manager.act("mcp", "add", "add", ["docs", "https://other.example.com"], context)).rejects.toThrow("already has a server named docs");
    await expect(manager.act("mcp", "add", "add", ["bad name", "x"], context)).rejects.toThrow("letters, digits");
    await expect(manager.act("mcp", "add", "add", ["empty", " "], context)).rejects.toThrow("Enter a URL or a command line");
    expect(await file()).toEqual({ note: 1, mcpServers: { keep: { type: "http", url: "https://keep.example.com/mcp" },
      docs: { type: "http", url: "https://docs.example.com/mcp" }, files: { command: "npx", args: ["-y", "@scope/files", "--root", "my dir"] } } });
    expect((await stat(t.config.paths.mcp)).mode & 0o777).toBe(0o600);

    await manager.toggle("mcp", "user:docs", false, context);
    await manager.act("mcp", "user:keep", "remove", [], context);
    expect(Object.keys((await file()).mcpServers)).toEqual(["docs", "files"]);
    expect(JSON.parse(await readFile(t.config.paths.settings, "utf8"))).toEqual({ disabledMcpServers: ["docs"] });
    const rows = (await manager.panel("mcp", context)).rows;
    expect(rows.map((row) => [row.id, row.detail, row.enabled])).toEqual([
      ["user:docs", "http https://docs.example.com/mcp", false], ["user:files", "stdio npx -y @scope/files --root my dir", true],
      ["project:local", "stdio ./server, off in the file · this folder is not trusted; turn on Project MCP servers in /config", true],
      ["add", "Saved in ~/mcp.json", undefined]]);
    await expect(manager.act("mcp", "user:keep", "remove", [], context)).rejects.toThrow("has no server named keep");
  });

  it("changes the running agent's tools on the next turn", async () => {
    const script = await echoServer();
    const t = await testSetup([chatText("one"), chatText("two"), chatText("three")]);
    const manager = managerFor(t);
    const context = panelContext(t.root);
    const connection = await MemoryConnection.open(t.factory);
    const { sessionId } = await connection.newSession({ cwd: t.root });
    const tools = async (index: number) => JSON.stringify(t.fake.requests.filter((request) => request.method === "POST")[index].body);
    await connection.prompt(sessionId, "first");
    expect(await tools(0)).not.toContain("mcp__echo__echo");
    await manager.act("mcp", "add", "add", ["echo", `"${process.execPath}" "${script}"`], context);
    await connection.prompt(sessionId, "second");
    expect(await tools(1)).toContain("mcp__echo__echo");
    await manager.toggle("mcp", "user:echo", false, context);
    await connection.prompt(sessionId, "third");
    expect(await tools(2)).not.toContain("mcp__echo__echo");
    await connection.close();
  });
});
