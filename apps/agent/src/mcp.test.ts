import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chatText, chatTool } from "@oxbit/agent-core/test-models";
import { MemoryConnection } from "./connection.js";
import { nodeSpawn, projectTrusted } from "./mcp.js";
import { echoServer as serverScript, tempDir, testSetup } from "./testing.js";

const text = (updates: any[]) => updates.filter((update) => update.sessionUpdate === "agent_message_chunk").map((update) => update.content.text).join("");

describe("MCP in the Node host", () => {
  it("lists a session/new stdio server as mcp__<server>__<tool> and calls it through a prompt", async () => {
    const script = await serverScript();
    const t = await testSetup([chatTool("call_1", "mcp__echo__echo", { text: "hi" }), chatText("Done")]);
    const connection = await MemoryConnection.open(t.factory);
    expect(connection.initialized.agentCapabilities.mcpCapabilities).toEqual({ http: true, sse: true });
    const updates: any[] = [];
    connection.onUpdate((_id, update) => updates.push(update));
    const { sessionId } = await connection.newSession({ cwd: t.root, mcpServers: [{ name: "echo", command: process.execPath, args: [script], env: [] }] });
    await connection.setMode(sessionId, "full-auto");
    expect(await connection.prompt(sessionId, "Echo hi")).toEqual({ stopReason: "end_turn" });
    const first = t.fake.requests.find((request) => request.method === "POST")!;
    expect(JSON.stringify(first.body)).toContain("mcp__echo__echo");
    expect(updates).toContainEqual(expect.objectContaining({ sessionUpdate: "tool_call_update", toolCallId: "call_1", status: "completed",
      rawOutput: expect.stringContaining("echo: hi") }));
    await connection.close();
  });

  it("ignores a project .mcp.json until settings.json trusts the project", async () => {
    const script = await serverScript();
    const t = await testSetup([]);
    await writeFile(join(t.root, ".mcp.json"), JSON.stringify({ mcpServers: { local: { command: process.execPath, args: [script] } } }));
    const connection = await MemoryConnection.open(t.factory);
    const updates: any[] = [];
    connection.onUpdate((_id, update) => updates.push(update));
    const { sessionId } = await connection.newSession({ cwd: t.root });
    await connection.prompt(sessionId, "/mcp");
    expect(text(updates)).toContain(`${t.root}/.mcp.json is not trusted, so its servers are off: local. Add the project path to "trustedProjects"`);
    updates.length = 0;
    await writeFile(t.config.paths.settings, JSON.stringify({ trustedProjects: [t.root] }));
    await connection.prompt(sessionId, "/mcp reload");
    expect(text(updates)).toContain("- local (project, stdio, 2025-06-18): connected, 1 tools");
    await connection.close();
  });

  it("trusts listed projects and their subdirectories, or every project with trustProjectMcp", async () => {
    const home = await tempDir("oxa-trust-");
    const settings = join(home, "settings.json");
    expect(await projectTrusted(settings, "/work/app")).toBe(false);
    await writeFile(settings, JSON.stringify({ trustedProjects: ["/work", "relative"] }));
    expect([await projectTrusted(settings, "/work/app"), await projectTrusted(settings, "/work"), await projectTrusted(settings, "/workshop")]).toEqual([true, true, false]);
    await writeFile(settings, JSON.stringify({ trustProjectMcp: true }));
    expect(await projectTrusted(settings, "/anywhere")).toBe(true);
  });

  it("splits stdout into lines, passes stderr, and kills with SIGTERM then SIGKILL", async () => {
    const cwd = await tempDir("oxa-spawn-");
    let stderr = "";
    const child = nodeSpawn(undefined, 100)({ command: process.execPath, cwd, env: {}, stderr: (text) => void (stderr += text),
      args: ["-e", "process.on('SIGTERM', () => {}); console.log('one\\ntwo'); console.error('warn'); setInterval(() => {}, 1000)"] });
    const lines: string[] = [];
    for await (const line of child.stdout) {
      lines.push(line);
      if (lines.length === 2) break;
    }
    expect(lines).toEqual(["one", "two"]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(stderr).toContain("warn");
    child.kill();
    expect(await child.exited).toBe(null);
    const missing = nodeSpawn()({ command: join(cwd, "missing"), args: [], cwd, env: {}, stderr: (text) => void (stderr += text) });
    await missing.exited;
    for await (const line of missing.stdout) void line;
    expect(stderr).toContain("ENOENT");
  });
});
