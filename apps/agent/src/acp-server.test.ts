import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { Params } from "@oxbit/agent-core";
import { chatText, chatTool, hanging } from "@oxbit/agent-core/test-models";
import { serveStdio, type Message } from "./acp-server.js";
import type { AgentFactory } from "./host.js";
import { testSetup } from "./testing.js";

/** An NDJSON ACP client over a pair of in-memory streams. `answer` serves the agent's requests. */
function client(factory: AgentFactory, answer: (method: string, params: Params) => unknown = () => null) {
  const input = new PassThrough();
  const output = new PassThrough();
  const done = serveStdio({ input, output, factory });
  const lines: Message[] = [];
  const asked: [string, Params][] = [];
  const pending = new Map<number, (message: Message) => void>();
  let next = 0;
  const send = (message: Message) => input.write(`${JSON.stringify(message)}\n`);
  createInterface({ input: output }).on("line", async (line) => {
    const message: Message = JSON.parse(line);
    lines.push(message);
    if (message.method && message.id !== undefined) {
      asked.push([message.method, message.params]);
      send({ jsonrpc: "2.0", id: message.id, result: await answer(message.method, message.params) });
    } else if (message.id !== undefined && message.id !== null) pending.get(message.id as number)?.(message);
  });
  const call = (method: string, params: Params = {}) => new Promise<Message>((resolve) => {
    pending.set(++next, resolve);
    send({ jsonrpc: "2.0", id: next, method, params });
  });
  const updates = () => lines.filter((line) => line.method === "session/update").map((line) => line.params.update);
  return { input, call, send, lines, asked, updates, done };
}

describe("ACP server over NDJSON streams", () => {
  it("serves fs/* locally when the client does not advertise fs", async () => {
    const t = await testSetup([chatTool("call_1", "read_file", { path: "a.txt" }), chatText("Done")]);
    await writeFile(join(t.root, "a.txt"), "alpha");
    const c = client(t.factory);
    const init = await c.call("initialize", { protocolVersion: 1, clientCapabilities: {} });
    expect(init.result).toEqual(expect.objectContaining({ protocolVersion: 1,
      agentCapabilities: expect.objectContaining({ loadSession: true, sessionCapabilities: { fork: {}, list: {} } }) }));
    const created = await c.call("session/new", { cwd: t.root, mcpServers: [] });
    const sessionId = created.result.sessionId;
    expect(created.result.models.currentModelId).toBe("model-a");
    const prompted = await c.call("session/prompt", { sessionId, prompt: [{ type: "text", text: "Read a.txt" }] });
    expect(prompted.result).toEqual({ stopReason: "end_turn" });
    expect(c.asked).toEqual([]);
    expect(c.updates()).toContainEqual(expect.objectContaining({ sessionUpdate: "tool_call_update", toolCallId: "call_1", status: "completed", rawOutput: "alpha" }));
    expect(c.updates()).toContainEqual({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done" } });
    c.input.end();
    await c.done;
  });

  it("forwards fs/* and terminal/* to a client that advertised them", async () => {
    const t = await testSetup([chatTool("call_1", "read_file", { path: "a.txt" }), chatTool("call_2", "bash", { command: "echo hi" }), chatText("Done")]);
    const c = client(t.factory, (method) => ({
      "fs/read_text_file": { content: "from client" },
      "session/request_permission": { outcome: { outcome: "selected", optionId: "allow" } },
      "terminal/create": { terminalId: "term-1" },
      "terminal/wait_for_exit": { exitCode: 0, signal: null },
      "terminal/output": { output: "hi\n", truncated: false },
    } as Params)[method] ?? {});
    await c.call("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true } });
    const { result } = await c.call("session/new", { cwd: t.root, mcpServers: [] });
    await c.call("session/prompt", { sessionId: result.sessionId, prompt: [{ type: "text", text: "Go" }] });
    expect(c.asked.map(([method]) => method)).toEqual(["fs/read_text_file", "session/request_permission", "terminal/create",
      "terminal/wait_for_exit", "terminal/output", "terminal/release"]);
    expect(c.asked[0][1]).toEqual(expect.objectContaining({ path: join(t.root, "a.txt") }));
    expect(c.asked[2][1]).toEqual(expect.objectContaining({ command: "bash", args: ["-c", "echo hi"], cwd: t.root }));
    expect(c.updates()).toContainEqual(expect.objectContaining({ toolCallId: "call_1", status: "completed", rawOutput: "from client" }));
    expect(c.updates()).toContainEqual(expect.objectContaining({ toolCallId: "call_2", status: "completed", rawOutput: "hi\n[Exit code 0]" }));
    c.input.end();
    await c.done;
  });

  it("asks before a local write in ask mode and writes after approval", async () => {
    const t = await testSetup([chatTool("call_1", "write_file", { path: "out/b.txt", content: "beta" }), chatText("Saved")]);
    const c = client(t.factory, () => ({ outcome: { outcome: "selected", optionId: "allow" } }));
    await c.call("initialize", { protocolVersion: 1, clientCapabilities: {} });
    const { result } = await c.call("session/new", { cwd: t.root, mcpServers: [] });
    await c.call("session/prompt", { sessionId: result.sessionId, prompt: [{ type: "text", text: "Write" }] });
    expect(c.asked).toHaveLength(1);
    expect(c.asked[0][0]).toBe("session/request_permission");
    expect(c.asked[0][1].toolCall.content).toEqual([{ type: "diff", path: join(t.root, "out/b.txt"), oldText: null, newText: "beta" }]);
    expect(await readFile(join(t.root, "out/b.txt"), "utf8")).toBe("beta");
    c.input.end();
    await c.done;
  });

  it("cancels a prompt on the session/cancel notification", async () => {
    const t = await testSetup([hanging(chatText("Partial").slice(0, 1))]);
    const c = client(t.factory);
    await c.call("initialize", { protocolVersion: 1, clientCapabilities: {} });
    const { result } = await c.call("session/new", { cwd: t.root, mcpServers: [] });
    const prompt = c.call("session/prompt", { sessionId: result.sessionId, prompt: [{ type: "text", text: "Wait" }] });
    await new Promise((resolve) => setTimeout(resolve, 50));
    c.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: result.sessionId } });
    expect((await prompt).result).toEqual({ stopReason: "cancelled" });
    c.input.end();
    await c.done;
  });

  it("answers parse errors and unknown methods with JSON-RPC errors", async () => {
    const t = await testSetup([]);
    const c = client(t.factory);
    c.input.write("not json\n");
    const unknown = await c.call("session/unknown", {});
    expect(unknown.error).toEqual({ code: -32601, message: "Method not found: session/unknown" });
    expect(c.lines[0]).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    c.input.end();
    await c.done;
  });
});
