import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { chatText, chatTool } from "@oxbit/agent-core/test-models";
import { MemoryConnection } from "./connection.js";
import { LocalClient, routeRequests } from "./host.js";
import { Terminals } from "./shell.js";
import { tempDir, testSetup } from "./testing.js";

const selected = (optionId: string) => ({ outcome: { outcome: "selected", optionId } });

describe("LocalClient fs", () => {
  it("asks before a write without a mode mark and honors the answer", async () => {
    const root = await tempDir("oxa-fs-");
    const path = join(root, "a.txt");
    await writeFile(path, "old");
    const ask = vi.fn(async () => selected("reject"));
    const local = new LocalClient(ask);
    await expect(local.writeTextFile({ sessionId: "s", toolCallId: "c1", path, content: "new" })).rejects.toThrow("The user rejected this write");
    expect(await readFile(path, "utf8")).toBe("old");
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "s",
      toolCall: expect.objectContaining({ toolCallId: "c1", kind: "edit", content: [{ type: "diff", path, oldText: "old", newText: "new" }] }) }));

    ask.mockResolvedValueOnce(selected("allow"));
    await local.writeTextFile({ sessionId: "s", path, content: "new" });
    expect(await readFile(path, "utf8")).toBe("new");

    ask.mockResolvedValueOnce(selected("allow_always"));
    await local.writeTextFile({ sessionId: "s", path: join(root, "deep/b.txt"), content: "b" });
    await local.writeTextFile({ sessionId: "s", path, content: "again" });
    await local.writeTextFile({ sessionId: "other", path, content: "auto", _meta: { oxbit: { mode: "accept-edits" } } });
    expect(ask).toHaveBeenCalledTimes(3);
    expect(await readFile(join(root, "deep/b.txt"), "utf8")).toBe("b");
    expect(await readFile(path, "utf8")).toBe("auto");
  });

  it("reads line ranges and rejects relative paths", async () => {
    const root = await tempDir("oxa-fs-");
    await writeFile(join(root, "a.txt"), "1\n2\n3\n4");
    const local = new LocalClient(async () => selected("allow"));
    expect(await local.readTextFile({ path: join(root, "a.txt"), line: 2, limit: 2 })).toEqual({ content: "2\n3" });
    await expect(local.readTextFile({ path: "a.txt" })).rejects.toThrow("ACP paths must be absolute");
  });

  it("routes by client capabilities", async () => {
    const forwarded = vi.fn(async () => ({ content: "client" }));
    const capabilities = { fs: { readTextFile: true } };
    const route = routeRequests({ capabilities: () => capabilities, update: () => {}, request: forwarded }, new LocalClient(async () => null));
    expect(await route("fs/read_text_file", { path: "/x" })).toEqual({ content: "client" });
    await expect(route("terminal/output", { sessionId: "s", terminalId: "none" })).rejects.toThrow("Unknown terminal");
    await expect(route("oxbit/diagnostics", {})).rejects.toThrow("Language diagnostics are unavailable");
  });
});

describe("Terminals", () => {
  it("runs a real echo and reports output and exit status", async () => {
    const terminals = new Terminals();
    const { terminalId } = await terminals.handle("terminal/create", { sessionId: "s", command: "echo", args: ["hi"], cwd: await tempDir("oxa-term-") }) as any;
    expect(await terminals.handle("terminal/wait_for_exit", { sessionId: "s", terminalId })).toEqual({ exitCode: 0, signal: null });
    expect(await terminals.handle("terminal/output", { sessionId: "s", terminalId })).toEqual({ output: "hi\n", truncated: false, exitStatus: { exitCode: 0, signal: null } });
    await expect(terminals.handle("terminal/output", { sessionId: "other", terminalId })).rejects.toThrow("Unknown terminal");
    await terminals.handle("terminal/release", { sessionId: "s", terminalId });
    await expect(terminals.handle("terminal/output", { sessionId: "s", terminalId })).rejects.toThrow("Unknown terminal");
  });

  it("keeps the last bytes within the limit and kills on request", async () => {
    const terminals = new Terminals();
    const cwd = await tempDir("oxa-term-");
    const short = await terminals.handle("terminal/create", { sessionId: "s", command: "printf", args: ["abcdef"], cwd, outputByteLimit: 3 }) as any;
    await terminals.handle("terminal/wait_for_exit", { sessionId: "s", ...short });
    expect(await terminals.handle("terminal/output", { sessionId: "s", ...short })).toEqual(expect.objectContaining({ output: "def", truncated: true }));
    const long = await terminals.handle("terminal/create", { sessionId: "s", command: "sleep", args: ["10"], cwd }) as any;
    await terminals.handle("terminal/kill", { sessionId: "s", ...long });
    expect(await terminals.handle("terminal/wait_for_exit", { sessionId: "s", ...long })).toEqual({ exitCode: null, signal: "SIGTERM" });
    terminals.dispose();
  });

  it("runs the bash tool locally through terminal/*", async () => {
    const t = await testSetup([chatTool("call_1", "bash", { command: "echo hello from bash" }), chatText("Ran it")]);
    const connection = await MemoryConnection.open(t.factory);
    const updates: any[] = [];
    connection.onUpdate((_id, update) => updates.push(update));
    const { sessionId } = await connection.newSession({ cwd: t.root });
    await connection.setMode(sessionId, "full-auto");
    expect(await connection.prompt(sessionId, "Run it")).toEqual({ stopReason: "end_turn" });
    expect(updates).toContainEqual(expect.objectContaining({ toolCallId: "call_1", status: "completed", rawOutput: "hello from bash\n[Exit code 0]" }));
    await connection.close();
  });
});
