import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentACP } from "../src/agent-acp.js";
import { WorkspaceFiles } from "../src/filesystem.js";

describe("runtime-owned agent workspaces", () => {
  const cleanups: (() => Promise<unknown>)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });
  async function setup() {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "oxbit-agent-workspace-")));
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await fs.writeFile(path.join(root, "hello.txt"), "disk content\nsecond line");
    const events: { client: string; name: string; params: any }[] = [];
    const agent = new AgentACP(new WorkspaceFiles(root), (client, name, params) => events.push({ client, name, params }));
    cleanups.push(() => agent.dispose());
    const connection = await agent.start("owner", {
      provider: "codex", command: process.execPath,
      args: [path.resolve("tests/fixtures/agent-acp/agent.mjs")],
    }, undefined, "window-one");
    await agent.call("owner", connection.id, "session/new");
    const prompt = (text: string) => agent.call("owner", connection.id, "session/prompt", { text });
    return { root, agent, connection, events, prompt };
  }
  it("reattaches a running turn with owner isolation and an exclusive editor", async () => {
    const { agent, connection, events, prompt } = await setup();
    const turn = prompt("wait");
    agent.detach("window-one");
    expect(agent.hasWork).toBe(true);
    expect(agent.list("other").sessions).toEqual([]);
    expect(() => agent.attach("other", connection.id)).toThrow("ended");
    const snapshot = agent.attach("owner", connection.id, "window-two");
    expect(snapshot.busy).toBe(true);
    expect(snapshot.events.filter(e => e.name === "acp.turnStarted")).toHaveLength(1);
    expect(snapshot.events[0].params.text).toBe("wait");
    expect(() => agent.control("owner", connection.id, "window-one")).toThrow("Attach");
    agent.attach("owner", connection.id, "window-three");
    expect(events.find(e => e.name === "acp.attachedElsewhere")?.client).toBe("window-two");
    agent.cancel("owner", connection.id);
    await expect(turn).resolves.toEqual({ stopReason: "cancelled" });
    expect(agent.attach("owner", connection.id, "window-three").busy).toBe(false);
  });
  it("keeps queued follow-ups on the runtime and runs corrections after cancellation", async () => {
    const { agent, connection, prompt } = await setup();
    const turn = prompt("wait");
    await agent.enqueue("owner", connection.id, { text: "follow up", messageId: "follow-up" });
    agent.detach("window-one");
    await agent.enqueue("owner", connection.id, { text: "correction", messageId: "correction" }, true);
    await turn;
    await expect.poll(() => agent.list("owner").sessions[0].busy || agent.list("owner").sessions[0].queued > 0).toBe(false);
    const snapshot = agent.attach("owner", connection.id, "window-two");
    expect(snapshot.events.filter(e => e.name === "acp.turnStarted").map(e => e.params.text)).toEqual(["wait", "correction", "follow up"]);
    expect(snapshot.queue).toEqual([]);
    expect(new Set(snapshot.events.map(e => e.params.seq)).size).toBe(snapshot.events.length);
  });
  it("detaches the previous session when the editor switches live agents", async () => {
    const { root, agent, connection, prompt } = await setup();
    const next = await agent.start("owner", {
      provider: "codex", command: process.execPath,
      args: [path.resolve("tests/fixtures/agent-acp/agent.mjs")],
    }, undefined, "window-two");
    await agent.call("owner", next.id, "session/new");
    agent.attach("owner", next.id, "window-one");
    expect(() => agent.control("owner", connection.id, "window-one")).toThrow("Attach");
    await expect(prompt(`read:${root}/hello.txt`)).resolves.toEqual({ stopReason: "end_turn" });
    const snapshot = agent.attach("owner", connection.id, "window-one");
    expect(JSON.stringify(snapshot.events)).toContain("disk content");
    expect(() => agent.control("owner", next.id, "window-one")).toThrow("Attach");
  });
  it("pauses queued prompts on stop and failure and prevents losing them when changing sessions", async () => {
    const { agent, connection, prompt } = await setup();
    const turn = prompt("wait");
    await agent.enqueue("owner", connection.id, { text: "error", messageId: "failed" });
    agent.cancel("owner", connection.id);
    await turn;
    expect(agent.attach("owner", connection.id).queuePaused).toBe(true);
    await expect(agent.call("owner", connection.id, "session/new")).rejects.toThrow("queued");
    agent.resumeQueue("owner", connection.id);
    await expect.poll(() => agent.attach("owner", connection.id).queuePaused).toBe(true);
    expect(agent.dequeue("owner", connection.id, "failed").prompt.text).toBe("error");
    expect(agent.attach("owner", connection.id).queue).toEqual([]);
  });
  it("reads disk through native MCP while detached and rejects paths outside the workspace", async () => {
    const { agent, connection, prompt } = await setup();
    agent.detach("window-one");
    await prompt('mcp:oxbit_read_file:{"path":"hello.txt","line":2,"limit":1}');
    let snapshot = agent.attach("owner", connection.id);
    expect(JSON.stringify(snapshot.events)).toContain("second line");
    expect(snapshot.requests).toEqual([]);
    agent.detach("owner");
    await prompt('mcp:oxbit_read_file:{"path":"../outside"}');
    snapshot = agent.attach("owner", connection.id);
    expect(JSON.stringify(snapshot.events)).toContain("workspace");
    expect(snapshot.events.some(e => e.params.update?.content?.text?.includes('"isError":true'))).toBe(true);
  });
  it("uses live editor reads and holds native MCP writes for review across detach", async () => {
    const { root, agent, connection, events, prompt } = await setup();
    const read = prompt('mcp:oxbit_read_file:{"path":"hello.txt"}');
    await expect.poll(() => events.some(e => e.name === "acp.request")).toBe(true);
    const request = events.find(e => e.name === "acp.request")!.params;
    agent.respond("owner", connection.id, request.requestId, { content: "unsaved editor content" });
    await read;
    expect(JSON.stringify(agent.attach("owner", connection.id).events)).toContain("unsaved editor content");
    agent.detach("owner");
    const write = prompt('mcp:oxbit_propose_edit:{"path":"hello.txt","content":"proposed content"}');
    await expect.poll(() => agent.list("owner").sessions[0].pendingRequests).toBe(1);
    expect(await fs.readFile(path.join(root, "hello.txt"), "utf8")).toBe("disk content\nsecond line");
    const snapshot = agent.attach("owner", connection.id, "window-two");
    expect(snapshot.requests[0]).toMatchObject({ method: "fs/write_text_file", params: { path: "hello.txt", content: "proposed content" } });
    agent.respond("owner", connection.id, snapshot.requests[0].requestId, undefined, "Rejected by engineer");
    await write;
    expect(agent.attach("owner", connection.id).requests).toEqual([]);
    expect(await fs.readFile(path.join(root, "hello.txt"), "utf8")).toBe("disk content\nsecond line");
  });
  it("publishes native plans and reports editor availability in headless mode", async () => {
    const { agent, connection, prompt } = await setup();
    agent.detach("window-one");
    await prompt('mcp:oxbit_get_workspace:{}');
    await prompt('mcp:oxbit_update_plan:{"entries":[{"content":"Implement requested change","status":"in_progress"}]}');
    const snapshot = agent.attach("owner", connection.id);
    expect(snapshot.events.some(e => e.params.update?.content?.text?.includes('"clientConnected":false'))).toBe(true);
    expect(snapshot.events.some(e => e.params.update?.entries?.[0]?.content === "Implement requested change")).toBe(true);
  });
});
