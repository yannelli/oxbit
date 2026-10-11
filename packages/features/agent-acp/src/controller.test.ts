import { describe, expect, it, vi } from "vitest";
import { AgentController, type AgentRequest } from "./controller.js";
import { sessionControls } from "./session-controls.js";
import { createFeature } from "./index.js";
import { createKernel } from "../../../core/src/index.js";
import {
  AGENT_MODELS_SERVICE,
  MISSING_AGENT_KEY,
  OXBIT_AGENT_PROVIDER,
  OXBIT_AGENT_SETTINGS,
  type AgentModels,
  type FeatureOptions,
} from "@oxbit/sdk";
function setup(document?: any, persistence?: any) {
  const listeners = new Map<string, (params: any) => void>();
  const runtime = {
    connected: true,
    request: vi.fn<(...args: any[]) => Promise<any>>(async () => ({})),
    subscribe: vi.fn((event, fn) => {
      listeners.set(event, fn);
      return () => listeners.delete(event);
    }),
  };
  const filesystem = {
    read: vi.fn(async () => ({
      text: "disk\nsecond\nthird",
      revision: "disk-revision",
    })),
    write: vi.fn(async () => ({})),
  };
  const checkpoint = vi.fn<(...args: any[]) => Promise<any>>(async () => ({ unavailable: "not-repository" }));
  const options = {
    runtime: {
      ...runtime,
      request: (method: string, ...rest: any[]) =>
        (method.startsWith("acp.checkpoint.") ? checkpoint : runtime.request)(method, ...rest),
    },
    filesystem,
    documents: {
      get: () => document,
      open: vi.fn(async () => {
        if (document) return document;
        throw Object.assign(new Error("Missing"), { code: "ENOENT" });
      }),
      save: vi.fn(async () => {}),
    },
    workbench: { openFile: vi.fn(), refreshFiles: vi.fn(), persistence },
    kernel: { services: { optional: () => undefined } },
  } as unknown as FeatureOptions;
  const agent = new AgentController(options);
  agent.connection = {
    id: "connection",
    root: "/workspace",
    provider: "codex",
    sessionId: "session",
    authMethods: [],
  };
  return { agent, runtime, checkpoint, filesystem, listeners, options };
}
describe("ACP editor integration", () => {
  it("answers native workspace context from the open editor", async () => {
    const document = { text: { toString: () => "first\nselected text\n" } };
    const { agent, listeners, runtime, options } = setup(document);
    const workbench = options.workbench as any;
    workbench.state = { groups: [{ tabs: [{ path: "hello.txt" }] }] };
    workbench.activePath = () => "hello.txt";
    workbench.activeEditor = () => ({ state: { selection: { main: { from: 6, to: 19, empty: false } } } });
    (options.kernel as any).services = { optional: () => undefined, get: () => ({ diagnostics: new Map([["hello.txt", [{ message: "Issue", range: { start: { line: 1, character: 2 } } }]]]) }) };
    listeners.get("acp.request")!({ id: "connection", requestId: "workspace", method: "oxbit/workspace", params: {} });
    await expect.poll(() => runtime.request.mock.calls.length).toBe(1);
    expect(runtime.request).toHaveBeenCalledWith("acp.respond", expect.objectContaining({ result: expect.objectContaining({
      activeFile: "hello.txt", openFiles: ["hello.txt"],
      selection: expect.objectContaining({ text: "selected text" }),
      diagnostics: [expect.objectContaining({ path: "hello.txt", line: 2, character: 3 })],
    }) }));
    agent.dispose();
  });
  it("answers reads from unsaved editor state with line limits", async () => {
    const { agent, listeners, runtime, filesystem } = setup({
      text: { toString: () => "unsaved\nsecond\nthird" },
      dirty: true,
    });
    listeners.get("acp.request")!({
      id: "connection",
      requestId: "read",
      method: "fs/read_text_file",
      params: { path: "hello.txt", line: 2, limit: 1 },
    });
    await expect.poll(() => runtime.request.mock.calls.length).toBe(1);
    expect(runtime.request).toHaveBeenCalledWith(
      "acp.respond",
      expect.objectContaining({ result: { content: "second" } }),
    );
    expect(filesystem.read).not.toHaveBeenCalled();
    agent.dispose();
  });
  it("rejects replacement of dirty files", async () => {
    const { agent, listeners, runtime, filesystem } = setup({ dirty: true });
    listeners.get("acp.request")!({
      id: "connection",
      requestId: "write",
      method: "fs/write_text_file",
      params: { path: "hello.txt", content: "new" },
    });
    await expect.poll(() => runtime.request.mock.calls.length).toBe(1);
    expect(runtime.request).toHaveBeenCalledWith(
      "acp.respond",
      expect.objectContaining({
        error: expect.stringContaining("unsaved edits"),
      }),
    );
    expect(filesystem.write).not.toHaveBeenCalled();
    expect(agent.requests).toEqual([]);
    agent.dispose();
  });
  it("holds shared writes for review and saves the updated document", async () => {
    const doc = {
      dirty: false,
      state: "ready",
      version: 1,
      savedRevision: "disk-revision",
      text: { toString: () => "disk" },
      replace: vi.fn(),
    };
    const { agent, listeners, filesystem, options } = setup(doc);
    listeners.get("acp.request")!({
      id: "connection",
      requestId: "write",
      method: "fs/write_text_file",
      params: { path: "hello.txt", content: "new" },
    });
    await expect.poll(() => agent.requests.length).toBe(1);
    expect(filesystem.write).not.toHaveBeenCalled();
    await agent.applyFile(agent.requests[0]);
    expect(doc.replace).toHaveBeenCalledWith("new");
    expect(options.documents.save).toHaveBeenCalledWith(
      "hello.txt",
      undefined,
      { skipHooks: true },
    );
    expect(filesystem.write).not.toHaveBeenCalled();
    expect(agent.requests).toEqual([]);
    agent.dispose();
  });
  it("refuses an edit changed while its review was open", async () => {
    const { agent, filesystem, runtime } = setup({ dirty: false, version: 2 });
    const request = {
      id: "connection",
      requestId: "write",
      method: "fs/write_text_file",
      params: { path: "hello.txt", content: "new" },
      version: 1,
    } as AgentRequest;
    agent.requests.push(request);
    await agent.applyFile(request);
    expect(filesystem.write).not.toHaveBeenCalled();
    expect(runtime.request).toHaveBeenCalledWith(
      "acp.respond",
      expect.objectContaining({
        error: expect.stringContaining("changed during review"),
      }),
    );
    agent.dispose();
  });
  it("cleans up subscriptions and processes on disposal, including reactivation", async () => {
    const { options, runtime, listeners } = setup();
    const kernel = createKernel({ environment: "browser" });
    options.kernel = kernel;
    const extension = createFeature(options);
    expect(extension.manifest.enabledByDefault).toBe(false);
    kernel.extensions.register(extension);
    await kernel.extensions.disable(extension.manifest.id);
    await kernel.extensions.trigger("onStartup");
    expect(kernel.contributions.list()).toHaveLength(0);
    await kernel.extensions.activate(extension.manifest.id);
    expect(kernel.services.get("agentACP")).toBeInstanceOf(AgentController);
    await kernel.extensions.disable(extension.manifest.id);
    expect(listeners.size).toBe(0);
    expect(runtime.request).toHaveBeenCalledWith("acp.disconnect", {});
    expect(kernel.contributions.list()).toHaveLength(0);
    expect(
      kernel.commands.list().some((c) => c.id.startsWith("agentACP.")),
    ).toBe(false);
    await kernel.extensions.activate(extension.manifest.id);
    expect(kernel.contributions.list("activityView")).toHaveLength(2);
    kernel.dispose();
  });
});

function deferred<T = any>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function settings(agent: AgentController) {
  agent.connection!.configOptions = [
    {
      id: "model",
      name: "Model",
      type: "select",
      currentValue: "first",
      options: [
        { value: "first", name: "First" },
        { value: "second", name: "Second" },
      ],
    },
  ];
  return sessionControls(agent.connection)[0];
}
describe("ACP session lifecycle", () => {
  it("keeps the next turn's approval when the previous prompt RPC settles", async () => {
    const { agent, runtime, listeners } = setup();
    const prompt = deferred();
    runtime.request.mockReturnValueOnce(prompt.promise);
    agent.draft = "First";
    const first = agent.send();
    listeners.get("acp.turnStarted")!({ id: "connection", seq: 1, messageId: agent.messages[0].id, text: "First" });
    listeners.get("acp.turnEnded")!({ id: "connection", seq: 2, stopReason: "end_turn" });
    listeners.get("acp.turnStarted")!({ id: "connection", seq: 3, messageId: "next", text: "Next" });
    agent.requests.push({ id: "connection", requestId: "next-approval", method: "session/request_permission", params: {} });
    prompt.resolve({ stopReason: "end_turn" });
    await first;
    expect(agent.busy).toBe(true);
    expect(agent.requests.map(request => request.requestId)).toEqual(["next-approval"]);
    agent.dispose();
  });
  it("keeps the turn start time until the turn ends", () => {
    const { agent } = setup();
    const now = vi.spyOn(Date, "now").mockReturnValueOnce(1000).mockReturnValueOnce(5000);
    agent.busy = true;
    agent.busy = true;
    expect(agent.turnStartedAt).toBe(1000);
    agent.busy = false;
    expect(agent.turnStartedAt).toBeUndefined();
    now.mockRestore();
    agent.dispose();
  });
  it("keeps newer queue events and draft edits during enqueue and interrupt", async () => {
    const { agent, runtime, listeners } = setup();
    const enqueue = deferred();
    agent.busy = true;
    agent.draft = "Queue this";
    runtime.request.mockReturnValueOnce(enqueue.promise);
    const queued = agent.send();
    listeners.get("acp.queue")!({ id: "connection", seq: 1, queue: [{ id: "new", text: "Queue this" }], paused: false });
    agent.draft = "Edited while sending";
    enqueue.resolve({ queue: [], paused: true });
    await queued;
    expect(agent.queue.map(prompt => prompt.id)).toEqual(["new"]);
    expect(agent.draft).toBe("Edited while sending");
    const interrupt = deferred();
    runtime.request.mockReturnValueOnce(interrupt.promise);
    const sending = agent.interruptAndSend();
    expect(agent.status).toBe("Stopping…");
    listeners.get("acp.queue")!({ id: "connection", seq: 2, queue: [{ id: "priority", text: "Edited while sending" }], paused: false });
    listeners.get("acp.turnStarted")!({ id: "connection", seq: 3, messageId: "priority", text: "Edited while sending" });
    agent.draft = "New draft";
    interrupt.resolve({ queue: [], paused: true });
    await sending;
    expect(agent.queue.map(prompt => prompt.id)).toEqual(["priority"]);
    expect(agent.draft).toBe("New draft");
    expect(agent.status).toBe("Working…");
    agent.dispose();
  });
  it("does not attach a session after the runtime disconnects", async () => {
    const { agent, runtime, listeners } = setup();
    agent.connection = undefined;
    const pending = deferred();
    runtime.request.mockReturnValueOnce(pending.promise);
    const attach = agent.attachLive("live");
    await expect.poll(() => runtime.request.mock.calls.length).toBe(1);
    listeners.get("connection.change")!({ state: "disconnected" });
    pending.resolve({ connection: { id: "live", root: "/workspace", provider: "codex", sessionId: "live", authMethods: [] },
      busy: false, events: [], requests: [], queue: [], queuePaused: false, sequence: 0, truncated: false });
    await attach;
    expect(agent.connection).toBeUndefined();
    agent.dispose();
  });
  it("queues a prompt during a turn and lets the draft be restored for editing", async () => {
    const { agent, runtime, listeners } = setup();
    agent.busy = true;
    agent.draft = "Follow up";
    runtime.request.mockResolvedValueOnce({ queue: [{ id: "queued", text: "Follow up" }], paused: false });
    await agent.send();
    expect(runtime.request).toHaveBeenCalledWith("acp.enqueue", expect.objectContaining({ id: "connection", text: "Follow up" }));
    expect(agent.draft).toBe("");
    listeners.get("acp.queue")!({ id: "connection", seq: 1, queue: [{ id: "queued", text: "Follow up" }], paused: true });
    expect(agent.queuePaused).toBe(true);
    await agent.editQueued("queued");
    expect(agent.draft).toBe("Follow up");
    expect(agent.queue).toEqual([]);
    agent.dispose();
  });
  it("sends a queued prompt now by interrupting the turn and queues it again when that fails", async () => {
    const { agent, runtime } = setup();
    agent.busy = true;
    const later = { id: "later", text: "Later", context: [{ path: "a.ts", text: "a" }] };
    const message = { id: "connection", text: "Later", context: later.context, messageId: "later" };
    agent.queue = [{ id: "first", text: "First" }, later];
    await agent.sendQueuedNow("later");
    expect(runtime.request.mock.calls).toEqual([
      ["acp.dequeue", { id: "connection", promptId: "later" }],
      ["acp.interrupt", message],
    ]);
    expect(agent.queue.map((prompt) => prompt.id)).toEqual(["first"]);
    expect(agent.status).toBe("Stopping…");
    agent.cancelling = false;
    agent.status = "Working…";
    agent.queue = [later];
    runtime.request.mockClear();
    runtime.request.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("Agent is busy"));
    await expect(agent.sendQueuedNow("later")).rejects.toThrow("Agent is busy");
    expect(runtime.request.mock.calls.map(([method]) => method)).toEqual(["acp.dequeue", "acp.interrupt", "acp.enqueue"]);
    expect(runtime.request).toHaveBeenLastCalledWith("acp.enqueue", message);
    expect(agent.cancelling).toBe(false);
    expect(agent.status).toBe("Working…");
    agent.dispose();
  });
  it("keeps queued prompts when a conversation change is requested", async () => {
    const { agent, runtime } = setup();
    agent.queue = [{ id: "pending", text: "Keep queued" }];
    agent.draft = "Keep draft";
    await expect(agent.newSession()).rejects.toThrow("Run or remove queued messages");
    expect(agent.queue).toHaveLength(1);
    expect(agent.draft).toBe("Keep draft");
    expect(runtime.request).not.toHaveBeenCalled();
    agent.dispose();
  });
  it("replays a live turn once and restores its pending queue", async () => {
    const { agent, runtime, listeners } = setup();
    agent.connection = undefined;
    agent.draft = "Keep this draft";
    runtime.request.mockResolvedValueOnce({
      connection: { id: "live", root: "/workspace", provider: "codex", sessionId: "live-session", authMethods: [] },
      busy: true, queue: [{ id: "next", text: "Next" }], queuePaused: false,
      sequence: 2, truncated: false, requests: [],
      events: [
        { name: "acp.turnStarted", params: { id: "live", seq: 1, messageId: "turn", text: "First" } },
        { name: "acp.update", params: { id: "live", seq: 2, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Working" } } } },
      ],
    });
    await agent.attachLive("live");
    expect(agent.draft).toBe("Keep this draft");
    expect(agent.messages.map(message => message.text)).toEqual(["First", "Working"]);
    expect(agent.busy).toBe(true);
    expect(agent.queue).toHaveLength(1);
    listeners.get("acp.turnStarted")!({ id: "live", seq: 1, messageId: "turn", text: "First" });
    expect(agent.messages).toHaveLength(2);
    agent.requests.push({ id: "live", requestId: "approval", method: "session/request_permission", params: {} });
    listeners.get("acp.turnEnded")!({ id: "live", seq: 3, stopReason: "end_turn" });
    expect(agent.busy).toBe(false);
    expect(agent.requests).toEqual([]);
    agent.dispose();
  });
  it("records reported context usage", () => {
    const { agent, listeners } = setup();
    listeners.get("acp.update")!({ id: "connection", update: {
      sessionUpdate: "usage_update", used: 1200, size: 8000,
      cost: { amount: 0.02, currency: "USD" },
    } });
    expect(agent.usage).toEqual({ used: 1200, size: 8000, cost: { amount: 0.02, currency: "USD" } });
    agent.dispose();
  });
  it("blocks overlapping settings and prompts and applies all dependent config changes", async () => {
    const { agent, runtime } = setup();
    const control = settings(agent),
      pending = deferred();
    runtime.request.mockReturnValueOnce(pending.promise);
    const change = agent.setSessionControl(control, "second");
    expect(agent.updatingSettings).toBe(true);
    expect(agent.connection!.configOptions![0].currentValue).toBe("first");
    await agent.setSessionControl(control, "second");
    agent.draft = "Keep my draft";
    await agent.send();
    expect(runtime.request).toHaveBeenCalledTimes(1);
    expect(agent.draft).toBe("Keep my draft");
    const configOptions = [
      { ...agent.connection!.configOptions![0], currentValue: "second" },
      {
        id: "effort",
        name: "Effort",
        type: "select",
        currentValue: "low",
        options: [{ value: "low", name: "Low" }],
      },
    ];
    pending.resolve({ configOptions });
    await change;
    expect(agent.connection!.configOptions).toEqual(configOptions);
    expect(agent.updatingSettings).toBe(false);
    agent.dispose();
  });
  it("keeps confirmed settings on rejection and accepts provider updates", async () => {
    const { agent, runtime, listeners } = setup();
    const control = settings(agent);
    runtime.request.mockRejectedValueOnce(new Error("Model unavailable"));
    await agent.action(() => agent.setSessionControl(control, "second"));
    expect(agent.error).toBe("Model unavailable");
    expect(agent.updatingSettings).toBe(false);
    expect(agent.connection!.configOptions![0].currentValue).toBe("first");
    const configOptions = [
      { ...agent.connection!.configOptions![0], currentValue: "second" },
    ];
    listeners.get("acp.update")!({
      id: "connection",
      update: { sessionUpdate: "config_option_update", configOptions },
    });
    expect(sessionControls(agent.connection)[0].value).toBe("second");
    agent.dispose();
  });
  it("ends the working state after a prompt error and allows another prompt", async () => {
    const { agent, runtime } = setup();
    runtime.request.mockRejectedValueOnce(new Error("Rate limited"));
    agent.draft = "First prompt";
    await agent.action(() => agent.send());
    expect(agent.status).toBe("Turn failed");
    expect(agent.busy).toBe(false);
    expect(agent.error).toBe("Rate limited");
    runtime.request.mockResolvedValueOnce({ stopReason: "end_turn" });
    agent.draft = "Try again";
    await agent.action(() => agent.send());
    expect(agent.status).toBe("Ready");
    expect(agent.error).toBe("");
    agent.dispose();
  });
  it("allows retrying cancellation after a failed cancel request", async () => {
    const { agent, runtime } = setup();
    agent.busy = true;
    runtime.request.mockRejectedValueOnce(new Error("Cancel failed"));
    await agent.action(() => agent.cancel());
    expect(agent.cancelling).toBe(false);
    expect(agent.status).toBe("Working…");
    await agent.cancel();
    expect(runtime.request).toHaveBeenCalledTimes(2);
    agent.dispose();
  });
  it.each(["resolve", "reject"] as const)(
    "ignores a stale prompt that settles via %s after reconnect",
    async (settle) => {
      const { agent, runtime } = setup();
      const old = deferred(),
        current = deferred();
      runtime.request.mockReturnValueOnce(old.promise);
      agent.draft = "Old prompt";
      const first = agent.action(() => agent.send());
      await expect.poll(() => runtime.request.mock.calls.length).toBe(1);
      await agent.disconnect();
      agent.connection = {
        id: "new",
        sessionId: "new-session",
        root: "/workspace",
        provider: "codex",
        authMethods: [],
      };
      runtime.request.mockReturnValueOnce(current.promise);
      agent.draft = "New prompt";
      const next = agent.send();
      if (settle === "resolve") old.resolve({ stopReason: "end_turn" });
      else old.reject(new Error("Old connection ended"));
      await first;
      expect(agent.busy).toBe(true);
      expect(agent.status).toBe("Working…");
      expect(agent.error).toBe("");
      current.resolve({ stopReason: "end_turn" });
      await next;
      agent.dispose();
    },
  );
  it("stops a late start response after the user cancels connecting", async () => {
    const { agent, runtime } = setup();
    const connection = agent.connection!,
      pending = deferred();
    agent.connection = undefined;
    runtime.request.mockReturnValueOnce(pending.promise);
    const start = agent.connect({ provider: "codex" });
    const signal = runtime.request.mock.calls[0][2].signal;
    await agent.disconnect();
    expect(signal.aborted).toBe(true);
    pending.resolve(connection);
    await start;
    expect(agent.connection).toBeUndefined();
    expect(agent.status).toBe("Disconnected");
    expect(runtime.request).toHaveBeenLastCalledWith("acp.stop", {
      id: connection.id,
    });
    agent.dispose();
  });
  it("does not let a cancelled start reset a later connection attempt", async () => {
    const { agent, runtime } = setup();
    agent.connection = undefined;
    const old = deferred(),
      current = deferred();
    runtime.request.mockReturnValueOnce(old.promise);
    const first = agent.action(() => agent.connect({ provider: "codex" }));
    await agent.disconnect();
    runtime.request.mockReturnValueOnce(current.promise);
    const next = agent.action(() => agent.connect({ provider: "cursor" }));
    old.reject(new Error("Cancelled"));
    await first;
    expect(agent.connecting).toBe(true);
    expect(agent.status).toBe("Connecting…");
    expect(agent.error).toBe("");
    await agent.disconnect();
    current.reject(new Error("Cancelled"));
    await next;
    agent.dispose();
  });
  it("guards session retries and ignores their result after runtime loss", async () => {
    const { agent, runtime, listeners } = setup();
    agent.connection!.sessionId = undefined;
    const pending = deferred();
    runtime.request.mockReturnValueOnce(pending.promise);
    const start = agent.newSession();
    await agent.newSession();
    expect(runtime.request).toHaveBeenCalledTimes(1);
    listeners.get("connection.change")!({ state: "disconnected" });
    pending.resolve({ id: "connection", sessionId: "late-session" });
    await start;
    expect(agent.connection).toBeUndefined();
    expect(agent.connecting).toBe(false);
    expect(agent.status).toContain("Runtime disconnected");
    agent.dispose();
  });
  it("does not reinsert an in-flight file review after disconnect", async () => {
    const { agent, options, listeners } = setup();
    const pending = deferred();
    vi.mocked(options.documents.open).mockReturnValueOnce(pending.promise);
    listeners.get("acp.request")!({
      id: "connection",
      requestId: "write",
      method: "fs/write_text_file",
      params: { path: "hello.txt", content: "new" },
    });
    await agent.disconnect();
    pending.reject(new Error("File read failed"));
    await pending.promise.catch(() => {});
    expect(agent.requests).toEqual([]);
    expect(agent.error).toBe("");
    agent.dispose();
  });
});

describe("ACP conversation workflows", () => {
  it("keeps interleaved tools in order and respects replay message IDs", () => {
    const { agent, listeners } = setup();
    const update = (update: any) =>
      listeners.get("acp.update")!({ id: "connection", update });
    update({
      sessionUpdate: "agent_message_chunk",
      content: { text: "Before" },
    });
    update({
      sessionUpdate: "tool_call",
      toolCallId: "read",
      title: "Read file",
      status: "pending",
    });
    update({
      sessionUpdate: "agent_message_chunk",
      content: { text: "After" },
    });
    update({
      sessionUpdate: "tool_call_update",
      toolCallId: "read",
      status: "completed",
    });
    update({
      sessionUpdate: "user_message_chunk",
      messageId: "a",
      content: { text: "One" },
    });
    update({
      sessionUpdate: "user_message_chunk",
      messageId: "b",
      content: { text: "Two" },
    });
    expect(agent.activity.map((a) => a.kind)).toEqual([
      "message",
      "tool",
      "message",
      "message",
      "message",
    ]);
    expect(agent.messages.map((m) => m.text)).toEqual([
      "Before",
      "After",
      "One",
      "Two",
    ]);
    expect(agent.tools.get("read")?.status).toBe("completed");
    agent.dispose();
  });
  it("persists drafts and transcript, reloads read-only without launching, and forgets locally", async () => {
    const values = new Map();
    const storage = {
      get: vi.fn(async (key) => values.get(key)),
      set: vi.fn(async (key, value) => {
        values.set(key, value);
      }),
    };
    const { agent, runtime } = setup(undefined, storage);
    runtime.request.mockResolvedValueOnce({
      ...agent.connection,
      sessionId: "created",
    });
    await agent.newSession();
    agent.draft = "Remember this";
    runtime.request.mockResolvedValueOnce({ stopReason: "end_turn" });
    await agent.send();
    agent.draft = "Draft for later";
    agent.context = [{ path: "hello.txt", text: "snapshot" }];
    await agent.saveConversation();
    const other = setup(undefined, storage);
    await other.agent.history.ready;
    expect(other.runtime.request).not.toHaveBeenCalled();
    const saved = other.agent.history.entries[0];
    expect(saved.draft).toBe("Draft for later");
    expect(saved.activity).toHaveLength(1);
    await other.agent.viewConversation(saved);
    expect(other.agent.archived).toBe(true);
    expect(other.agent.draft).toBe("Draft for later");
    await other.agent.send();
    expect(
      other.runtime.request.mock.calls.some(
        (c) => c[1]?.method === "session/prompt",
      ),
    ).toBe(false);
    await other.agent.forgetConversation(saved.id);
    await other.agent.saveConversation();
    expect(other.agent.history.entries).toHaveLength(0);
    agent.dispose();
    other.agent.dispose();
  });
  it("restores provider history once and retains the draft during replay", async () => {
    const { agent, runtime, listeners } = setup();
    const connection = {
      ...agent.connection,
      capabilities: { loadSession: true },
    };
    agent.connection = connection;
    runtime.request.mockImplementationOnce(async () => {
      listeners.get("acp.update")!({
        id: "connection",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { text: "Replayed" },
        },
      });
      return { ...connection, sessionId: "restored" };
    });
    await agent.restoreConversation({
      id: "saved",
      sessionId: "restored",
      root: "/workspace",
      provider: "codex",
      title: "Saved",
      updatedAt: "2026-09-08",
      draft: "Unsent",
      context: [],
      activity: [
        { kind: "message", message: { role: "agent", text: "Old preview" } },
      ],
      tools: [],
    });
    expect(agent.messages.map((m) => m.text)).toEqual(["Replayed"]);
    expect(agent.draft).toBe("Unsent");
    expect(agent.connection?.sessionId).toBe("restored");
    expect(runtime.request).toHaveBeenCalledTimes(1);
    agent.dispose();
  });
  it("undoes an applied edit and refuses to overwrite newer work", async () => {
    let text = "before";
    const doc = {
      dirty: false,
      state: "ready",
      version: 1,
      savedRevision: "one",
      text: { toString: () => text },
      replace: (value: string) => {
        text = value;
      },
    };
    const { agent, listeners, options, filesystem } = setup(doc);
    vi.mocked(options.documents.save).mockImplementation(async () => {
      doc.savedRevision = "two";
    });
    listeners.get("acp.request")!({
      id: "connection",
      requestId: "write",
      method: "fs/write_text_file",
      params: { path: "hello.txt", content: "after" },
    });
    await expect.poll(() => agent.requests.length).toBe(1);
    await agent.applyFile(agent.requests[0]);
    filesystem.read.mockResolvedValue({ text: "after", revision: "two" });
    doc.dirty = true;
    await expect(agent.undoChange(agent.changes[0].id)).rejects.toThrow(
      "changed after",
    );
    doc.dirty = false;
    await agent.undoChange(agent.changes[0].id);
    expect(text).toBe("before");
    expect(agent.changes[0].undone).toBe(true);
    agent.dispose();
  });
});

describe("ACP thread mentions", () => {
  it("attaches an earlier thread's transcript once and lists threads from the connected root", () => {
    const { agent } = setup();
    const entry = (id: string, root: string) => ({
      id, sessionId: id, root, provider: "codex", title: `Login ${id}`, updatedAt: "2026-10-10T12:00:00.000Z",
      draft: "", context: [], tools: [], activity: [{ kind: "message", message: { role: "user", text: `Question ${id}` } }],
    }) as any;
    agent.history.entries = [entry("here", "/workspace"), entry("there", "/other")];
    expect(agent.mentionThreads("login").map((thread) => thread.id)).toEqual(["here"]);
    agent.attachMention({ kind: "thread", id: "here", title: "Login here", agent: "Codex", updatedAt: "" });
    agent.attachThread("here");
    expect(agent.context).toEqual([{
      path: ".", kind: "thread", label: "Thread: Login here",
      text: "Earlier conversation with Codex ACP: Login here\n\nUser: Question here",
    }]);
    expect(() => agent.attachThread("missing")).toThrow("This conversation is no longer in history");
    agent.history.entries = [{ ...entry("empty", "/workspace"), activity: [] }];
    expect(() => agent.attachThread("empty")).toThrow("This conversation has no messages");
    agent.dispose();
  });
});
describe("dispatched subagents in the editor", () => {
  const child = (id = "a", parentId?: string): any => ({
    id,
    parentId,
    rootSessionId: "session",
    sessionId: id,
    provider: "codex",
    name: id,
    task: "Inspect routing",
    toolCallIds: [],
    state: "running",
    phase: "thinking",
    evidence: "native",
    visibility: "full",
    observedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    activity: [],
  });
  const receive = (
    listeners: Map<string, any>,
    subagent: any,
    activeCount = 1,
  ) =>
    listeners.get("acp.subagent")({
      id: "connection",
      rootSessionId: "session",
      subagent,
      activeCount,
      removedIds: [],
      truncated: false,
    });
  it("isolates child transcripts, synchronizes selection and keeps approvals after a root turn", async () => {
    const { agent, listeners, runtime } = setup();
    let finish!: (value: any) => void;
    runtime.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    agent.draft = "Delegate";
    const turn = agent.send();
    await expect.poll(() => runtime.request.mock.calls.length).toBe(1);
    receive(listeners, child());
    receive(listeners, child("b", "a"), 2);
    agent.selectSubagent("b");
    expect(agent.expandedSubagents.has("a")).toBe(true);
    listeners.get("acp.update")!({
      id: "connection",
      rootSessionId: "session",
      sessionId: "b",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { text: "Private child activity" },
      },
    });
    expect(agent.messages.some((m) => m.text.includes("Private child"))).toBe(
      false,
    );
    const request = {
      id: "connection",
      sessionId: "b",
      rootSessionId: "session",
      subagentId: "b",
      requestId: "permission",
      method: "session/request_permission",
      params: { options: [] },
    };
    listeners.get("acp.request")!(request);
    finish({ stopReason: "end_turn" });
    await turn;
    expect(agent.busy).toBe(false);
    expect(agent.requests).toEqual([request]);
    await expect(agent.newSession()).rejects.toThrow("pending requests");
    listeners.get("acp.requestsExpired")!({
      id: "connection",
      requestIds: ["permission"],
    });
    expect(agent.requests).toEqual([]);
    agent.dispose();
  });
  it("never revives historical children and reconciles replay with saved drafts", async () => {
    const values = new Map();
    const persistence = {
      get: async (key: string) => values.get(key),
      set: async (key: string, value: any) => {
        values.set(key, value);
      },
    };
    const { agent, listeners, runtime } = setup(undefined, persistence);
    runtime.request.mockResolvedValueOnce(agent.connection);
    await agent.newSession();
    receive(listeners, child());
    agent.draft = "Saved draft";
    await agent.saveConversation();
    const saved = agent.history.entries[0];
    expect(saved.subagents?.[0].historical).toBe(true);
    const other = setup(undefined, persistence);
    await other.agent.history.ready;
    expect(other.runtime.request).not.toHaveBeenCalled();
    await other.agent.viewConversation(saved);
    expect(other.agent.subagents.get("a")?.historical).toBe(true);
    expect(other.agent.activeSubagentCount).toBe(0);
    other.agent.connection = {
      ...agent.connection!,
      capabilities: { loadSession: true },
    };
    other.runtime.request.mockImplementation(async (_method, params) => {
      if (params?.method === "session/load") {
        receive(other.listeners, { ...child(), historical: true }, 0);
        return other.agent.connection;
      }
      return {};
    });
    await other.agent.restoreConversation(saved);
    expect(other.agent.subagents.size).toBe(1);
    expect(
      other.agent.activity.filter((a) => a.kind === "subagent"),
    ).toHaveLength(1); // Replay reconciles the existing child without duplicating it.
    expect(other.agent.draft).toBe("Saved draft");
    expect(other.agent.activeSubagentCount).toBe(0);
    agent.dispose();
    other.agent.dispose();
  });
  it("rejects a second child's stale proposal to the same shared document", async () => {
    let text = "disk";
    const doc = {
      dirty: false,
      state: "ready",
      version: 1,
      savedRevision: "disk-revision",
      text: { toString: () => text },
      replace(value: string) {
        text = value;
        this.version++;
      },
    };
    const { agent, listeners, runtime } = setup(doc);
    for (const id of ["a", "b"])
      listeners.get("acp.request")!({
        id: "connection",
        requestId: id,
        sessionId: id,
        rootSessionId: "session",
        subagentId: id,
        method: "fs/write_text_file",
        params: { path: "hello.txt", content: id },
      });
    await expect.poll(() => agent.requests.length).toBe(2);
    await agent.applyFile(agent.requests[0]);
    await agent.applyFile(agent.requests[0]);
    expect(text).toBe("a");
    expect(runtime.request).toHaveBeenCalledWith(
      "acp.respond",
      expect.objectContaining({
        requestId: "b",
        error: expect.stringContaining("changed during review"),
      }),
    );
    agent.dispose();
  });
  it("keeps selection stable when input arrives and ignores another root's events", () => {
    const { agent, listeners } = setup();
    receive(listeners, child());
    agent.selectSubagent("a");
    receive(listeners, { ...child("b", "a"), phase: "awaiting_input" }, 2);
    expect(agent.selectedSubagent).toBe("a");
    expect(agent.expandedSubagents.has("a")).toBe(true);
    listeners.get("acp.subagent")!({
      id: "connection",
      rootSessionId: "foreign",
      subagent: child("evil"),
      activeCount: 3,
      removedIds: [],
    });
    expect(agent.subagents.has("evil")).toBe(false);
    listeners.get("acp.exit")!({ id: "connection", reason: "Disconnected" });
    expect(agent.activeSubagentCount).toBe(0);
    expect(agent.subagents.get("a")?.state).toBe("disconnected");
    agent.dispose();
  });
  it("does not reinsert an expired child proposal after a delayed editor read", async () => {
    const { agent, listeners, options } = setup();
    let opened!: (doc: any) => void;
    (options.documents.open as any).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          opened = resolve;
        }),
    );
    listeners.get("acp.request")!({
      id: "connection",
      sessionId: "a",
      rootSessionId: "session",
      subagentId: "a",
      requestId: "late-child",
      method: "fs/write_text_file",
      params: { path: "hello.txt", content: "stale" },
    });
    listeners.get("acp.requestsExpired")!({
      id: "connection",
      requestIds: ["late-child"],
    });
    opened({
      dirty: false,
      state: "ready",
      text: { toString: () => "disk" },
      version: 1,
      savedRevision: "revision",
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(agent.requests).toEqual([]);
    agent.dispose();
  });
  it("preserves timeline position and selection when a task gains its provider ID", () => {
    const { agent, listeners } = setup();
    receive(listeners, { ...child("provisional"), toolCallIds: ["task"] }, 0);
    agent.selectSubagent("provisional");
    agent.activity.push({ kind: "notice", text: "After dispatch" });
    listeners.get("acp.subagent")!({
      id: "connection",
      rootSessionId: "session",
      subagent: { ...child("identified"), toolCallIds: ["task"] },
      activeCount: 0,
      removedIds: ["provisional"],
      truncated: false,
    });
    expect(agent.selectedSubagent).toBe("identified");
    expect(agent.activity).toEqual([
      { kind: "subagent", id: "identified" },
      { kind: "notice", text: "After dispatch" },
    ]);
    agent.dispose();
  });
});
describe("ACP checkpoints", () => {
  const before = "a".repeat(40), after = "b".repeat(40);
  it("stores a checkpoint on each sent message and still sends when creation fails", async () => {
    const { agent, runtime, checkpoint } = setup();
    checkpoint.mockResolvedValueOnce({ tree: before });
    agent.draft = "First";
    await agent.send();
    expect(agent.messages[0].checkpoint).toBe(before);
    checkpoint.mockRejectedValueOnce(new Error("Checkpoint failed"));
    agent.draft = "Second";
    await agent.send();
    expect(agent.messages[1].checkpoint).toBeUndefined();
    expect(runtime.request.mock.calls.filter((call) => call[1]?.method === "session/prompt")).toHaveLength(2);
    agent.dispose();
  });
  it("restores after checking unsaved edits and notes the restore in the conversation", async () => {
    const document = { dirty: true };
    const { agent, checkpoint, options } = setup(document);
    const message = { id: "m", role: "user" as const, text: "Rewrite hello", checkpoint: before };
    agent.messages.push(message);
    agent.activity.push({ kind: "message", message });
    checkpoint.mockImplementation(async (method: string) =>
      method === "acp.checkpoint.diff"
        ? { tree: after, changes: [{ status: "M", path: "hello.txt" }] }
        : { restored: ["hello.txt"], deleted: [] });
    agent.busy = true;
    await expect(agent.restoreCheckpoint(message)).rejects.toThrow("Wait for the agent");
    agent.busy = false;
    await expect(agent.restoreCheckpoint(message)).rejects.toThrow("unsaved edits in hello.txt");
    expect(checkpoint).not.toHaveBeenCalledWith("acp.checkpoint.restore", expect.anything());
    document.dirty = false;
    await agent.restoreCheckpoint(message);
    expect(checkpoint).toHaveBeenCalledWith("acp.checkpoint.restore", { tree: before, paths: ["hello.txt"] });
    expect(agent.activity.at(-1)).toEqual({
      kind: "notice", text: "Restored files to before “{message}”", values: { message: "Rewrite hello" },
    });
    expect(agent.checkpoints.current).toBe(before);
    expect(options.workbench.refreshFiles).toHaveBeenCalled();
    agent.dispose();
  });
});

describe("ACP branch, commit and folder mentions", () => {
  it("attaches the branch diff once and hides it when the runtime lacks git.branchDiff", async () => {
    const { agent, runtime } = setup();
    runtime.request.mockImplementation(async (method: string) => method === "git.branchDiff"
      ? { base: "main", head: "feature", truncated: false, files: [{ path: "a.ts", diff: "+a", binary: false }] }
      : {});
    agent.probeBranchDiff();
    agent.probeBranchDiff();
    expect(runtime.request.mock.calls.filter(([method]) => method === "git.branchDiff")).toEqual([["git.branchDiff", { limit: 0 }]]);
    await agent.attachMention({ kind: "branch" });
    await agent.attachMention({ kind: "branch" });
    expect(agent.context).toEqual([{
      path: ".", kind: "branch", label: "Branch diff: main...feature",
      text: "Changes on feature since its merge base with main, including uncommitted changes\n\n+a",
    }]);
    expect(agent.branchDiffAvailable).toBe(true);
    agent.dispose();

    const older = setup();
    older.runtime.request.mockRejectedValue(Object.assign(new Error("Unknown runtime method git.branchDiff"), { code: "METHOD_NOT_FOUND" }));
    older.agent.probeBranchDiff();
    await expect.poll(() => older.agent.branchDiffAvailable).toBe(false);
    older.agent.dispose();

    const device = setup();
    device.runtime.request.mockRejectedValue(new Error("git.branchDiff needs a runtime workspace"));
    await expect(device.agent.attachBranchDiff()).rejects.toThrow("Branch diff needs a runtime workspace");
    expect(device.agent.branchDiffAvailable).toBe(false);
    device.agent.dispose();

    const unrelated = setup();
    unrelated.runtime.request.mockRejectedValue(Object.assign(new Error("No base branch"), { code: "NOT_FOUND" }));
    await expect(unrelated.agent.attachBranchDiff()).rejects.toThrow("No base branch");
    expect(unrelated.agent.branchDiffAvailable).toBe(true);
    unrelated.agent.dispose();
  });
  it("lists matching commits and attaches one commit's message and diff", async () => {
    const { agent, runtime } = setup();
    const commit = { id: "abc1234def", parents: [], author: "Ada", date: "2026-10-10", subject: "Fix login", body: "", refs: "" };
    runtime.request.mockImplementation(async (method: string) => {
      if (method === "git.log") return { commits: [{ ...commit, id: "fff0000", subject: "Docs" }, commit], hasMore: false };
      if (method === "git.show") return { commit, files: [{ path: "a.ts", status: "M" }] };
      if (method === "git.commitDiff") return { diff: "+fixed", after: "", binary: false };
      return {};
    });
    const found = await agent.mentionCommits("login");
    expect(found.map((item) => item.id)).toEqual(["abc1234def"]);
    expect(runtime.request).toHaveBeenCalledWith("git.log", { limit: 100 });
    await agent.attachMention(found[0]);
    await agent.attachMention(found[0]);
    expect(agent.context).toEqual([{
      path: ".", kind: "commit", label: "Commit abc1234: Fix login",
      text: "commit abc1234def\nAuthor: Ada\nDate: 2026-10-10\n\nFix login\n\n+fixed",
    }]);
    expect(await agent.mentionCommits(" ")).toEqual([]);
    agent.dispose();
  });
  it("attaches a folder's files once", async () => {
    const { agent, options } = setup();
    (options.filesystem as any).list = async (path: string) =>
      path === "src" ? [{ path: "src/a.ts", name: "a.ts", kind: "file" }] : [];
    await agent.attachMention({ kind: "folder", path: "src" });
    await agent.attachMention({ kind: "folder", path: "src" });
    expect(agent.context).toEqual([{
      path: "src", kind: "folder", label: "Folder: src",
      text: "Folder src: 1 file, 1 with their text below\n\nsrc/a.ts\n\n--- src/a.ts\ndisk\nsecond\nthird",
    }]);
    agent.dispose();
  });
});
describe("Fork from here", () => {
  const tree = "a".repeat(40);
  async function conversation(document?: any) {
    const context = setup(document);
    context.runtime.request.mockImplementation(async (method: string, params: any) =>
      method === "acp.call" && params.method === "session/new"
        ? { id: "connection", root: "/workspace", provider: "codex", sessionId: `session-${crypto.randomUUID()}`, authMethods: [] }
        : {});
    await context.agent.newSession();
    const first = { id: "1", role: "user" as const, text: "Why does login fail?" };
    const second = { id: "3", role: "user" as const, text: "Refresh it", checkpoint: tree };
    for (const message of [first, { id: "2", role: "agent" as const, text: "Token expired." }, second]) {
      context.agent.messages.push(message);
      context.agent.activity.push({ kind: "message", message });
    }
    context.agent.title = "Fix login";
    context.agent.draft = "unsent";
    return { ...context, first, second, original: (context.agent as any).activeConversation.id as string };
  }
  it("opens a new conversation with the earlier messages attached and the message drafted", async () => {
    const { agent, first, second, original } = await conversation();
    await agent.forkFrom(second);
    expect((agent as any).activeConversation.id).not.toBe(original);
    expect(agent.activity).toEqual([]);
    expect(agent.title).toBe("New conversation");
    expect(agent.draft).toBe("Refresh it");
    expect(agent.context).toEqual([{
      path: ".", kind: "thread", label: "Thread: Fix login",
      text: "Earlier conversation with Codex ACP: Fix login\n\nUser: Why does login fail?\n\nAgent: Token expired.",
    }]);
    const saved = agent.history.entries.find((entry) => entry.id === original)!;
    expect(saved.activity).toHaveLength(3);
    expect(saved.draft).toBe("unsent");
    await agent.forkFrom(first);
    expect(agent.draft).toBe("Refresh it");
    agent.dispose();

    const again = await conversation();
    await again.agent.forkFrom(again.first);
    expect(again.agent.draft).toBe("Why does login fail?");
    expect(again.agent.context).toEqual([]);
    again.agent.dispose();
  });
  it("restores the checkpoint first and notes the restore in the fork only", async () => {
    const { agent, checkpoint, options, second, original } = await conversation({ dirty: false });
    checkpoint.mockImplementation(async (method: string) =>
      method === "acp.checkpoint.diff"
        ? { tree: "b".repeat(40), changes: [{ status: "M", path: "hello.txt" }] }
        : { restored: ["hello.txt"], deleted: [] });
    await agent.forkFrom(second, true);
    expect(checkpoint).toHaveBeenCalledWith("acp.checkpoint.restore", { tree, paths: ["hello.txt"] });
    expect(options.workbench.refreshFiles).toHaveBeenCalled();
    expect(agent.draft).toBe("Refresh it");
    expect(agent.activity).toEqual([{
      kind: "notice", text: "Restored files to before “{message}”", values: { message: "Refresh it" },
    }]);
    expect(agent.history.entries.find((entry) => entry.id === original)!.activity).toHaveLength(3);
    agent.dispose();
  });
  it("refuses while the agent works and keeps the conversation when restore fails", async () => {
    const { agent, checkpoint, second, original } = await conversation({ dirty: true });
    agent.busy = true;
    await expect(agent.forkFrom(second)).rejects.toThrow("Wait for the agent to finish before forking");
    agent.busy = false;
    checkpoint.mockResolvedValue({ tree: "b".repeat(40), changes: [{ status: "M", path: "hello.txt" }] });
    await expect(agent.forkFrom(second, true)).rejects.toThrow("unsaved edits in hello.txt");
    expect((agent as any).activeConversation.id).toBe(original);
    expect(agent.draft).toBe("unsent");
    agent.dispose();
  });
});

describe("Oxbit agent without a runtime workspace", () => {
  async function activate(models?: AgentModels, saved = "claude") {
    const { options } = setup();
    const kernel = createKernel({ environment: "browser" });
    Object.assign(options, { kernel, runtime: undefined });
    if (models) kernel.services.register(AGENT_MODELS_SERVICE, models);
    const extension = createFeature(options);
    kernel.extensions.register(extension);
    await kernel.extensions.activate(extension.manifest.id);
    await kernel.configuration.set("agentACP.provider", saved, "user");
    return { kernel, agent: kernel.services.get<AgentController>("agentACP") };
  }
  const fakeModels = (has = false) => ({
    stream: vi.fn(),
    keys: { has: vi.fn(async () => has), save: vi.fn(), remove: vi.fn() },
  }) as unknown as AgentModels & { keys: { has: ReturnType<typeof vi.fn> } };
  it("defaults a local workspace to the Oxbit agent and keeps the saved choice", async () => {
    const { kernel, agent } = await activate(fakeModels());
    expect(agent.local).toBe(true);
    expect(agent.chosen).toEqual({ provider: OXBIT_AGENT_PROVIDER });
    expect(agent.displayName).toBe("Oxbit Agent");
    await agent.select({ provider: OXBIT_AGENT_PROVIDER });
    expect(kernel.configuration.get("agentACP.provider")).toBe("claude");
    await expect(agent.listLiveSessions()).resolves.toBeUndefined();
    kernel.dispose();
  });
  it("keeps today's runtime prompt when the host has no model service", async () => {
    const { kernel, agent } = await activate();
    expect(agent.local).toBe(false);
    expect(agent.chosen).toEqual({ provider: "claude" });
    await expect(agent.connectSelected()).rejects.toThrow("Connect to a runtime workspace first");
    kernel.dispose();
  });
  it("rejects Start with the setup error until the endpoint has a key", async () => {
    const models = fakeModels();
    const { kernel, agent } = await activate(models);
    await kernel.configuration.set(OXBIT_AGENT_SETTINGS.api, "openai-compatible", "user");
    await kernel.configuration.set(OXBIT_AGENT_SETTINGS.baseUrl, "https://openrouter.ai/api", "user");
    await agent.action(() => agent.connectSelected());
    expect(agent.error).toBe(MISSING_AGENT_KEY);
    expect(agent.status).toBe("Connection failed");
    expect(models.keys.has).toHaveBeenCalledWith({ api: "openai-compatible", baseUrl: "https://openrouter.ai/api" });
    kernel.dispose();
  });
  it("falls back from a saved Oxbit choice in a runtime workspace", () => {
    const { agent, options } = setup();
    const set = vi.fn();
    (options.kernel as any).configuration = { get: () => OXBIT_AGENT_PROVIDER, set };
    expect(agent.local).toBe(false);
    expect(agent.chosen).toEqual({ provider: "codex" });
    agent.selection = { provider: "opencode", registry: { id: "opencode" } };
    expect(agent.chosen.provider).toBe("opencode");
    agent.dispose();
  });
});
