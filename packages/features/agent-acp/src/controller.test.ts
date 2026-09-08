import { describe, expect, it, vi } from "vitest";
import { AgentController, type AgentRequest } from "./controller.js";
import { sessionControls } from "./session-controls.js";
import { createFeature } from "./index.js";
import { createKernel } from "../../../core/src/index.js";
import type { FeatureOptions } from "@oxbit/sdk";
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
  const options = {
    runtime,
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
    kernel: {},
  } as unknown as FeatureOptions;
  const agent = new AgentController(options);
  agent.connection = {
    id: "connection",
    root: "/workspace",
    provider: "codex",
    sessionId: "session",
    authMethods: [],
  };
  return { agent, runtime, filesystem, listeners, options };
}
describe("ACP editor integration", () => {
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
    expect(kernel.contributions.list("activityView")).toHaveLength(1);
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
