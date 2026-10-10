import { describe, expect, it, vi } from "vitest";
import type { ACPLiveSession, FeatureOptions } from "@oxbit/sdk";
import { AgentController } from "./controller.js";
import { AGENT_LIMIT_STATUS, showThreads, stopThread, threadState } from "./threads.js";

function setup() {
  const listeners = new Map<string, (params: any) => void>();
  const values = new Map<string, any>();
  const runtime = {
    connected: true,
    request: vi.fn<(...args: any[]) => Promise<any>>(async () => ({})),
    subscribe: vi.fn((event: string, fn: (params: any) => void) => {
      listeners.set(event, fn);
      return () => listeners.delete(event);
    }),
  };
  const workbench = {
    notify: vi.fn(),
    setViewBadge: vi.fn(),
    persistence: {
      get: async (key: string) => values.get(key),
      set: async (key: string, value: any) => void values.set(key, value),
    },
  };
  const options = {
    runtime,
    filesystem: { id: "fs" },
    documents: {},
    workbench,
    kernel: { configuration: { get: () => undefined } },
  } as unknown as FeatureOptions;
  const agent = new AgentController(options);
  agent.connection = { id: "first", root: "/w", provider: "codex", sessionId: "s1", authMethods: [] };
  return { agent, runtime, listeners, workbench };
}
const live = (id: string, extra: Partial<ACPLiveSession> = {}): ACPLiveSession => ({
  connection: { id, root: "/w", provider: "codex", sessionId: id, authMethods: [] },
  busy: false, title: id, pendingRequests: 0, queued: 0, ...extra,
});
const methods = (runtime: ReturnType<typeof setup>["runtime"]) =>
  runtime.request.mock.calls.map(([method]) => method);

describe("agent threads", () => {
  it("keeps the thread when pending requests, queued messages, or subagents block detaching", async () => {
    const blocked: [string, (agent: AgentController) => void][] = [
      ["Resolve pending requests", (agent) => agent.requests.push({ id: "first", requestId: "r", method: "session/request_permission", params: {} })],
      ["Run or remove queued messages", (agent) => (agent.queue = [{ id: "q", text: "Next" }])],
      ["Wait for active subagents", (agent) => (agent.activeSubagentCount = 1)],
    ];
    for (const [message, block] of blocked) {
      const { agent, runtime } = setup();
      block(agent);
      await expect(agent.detach()).rejects.toThrow(message);
      expect(agent.connection?.id).toBe("first");
      expect(runtime.request).not.toHaveBeenCalled();
      agent.dispose();
    }
  });
  it("ignores detach while a conversation starts or no agent is connected", async () => {
    const { agent, runtime } = setup();
    agent.connecting = true;
    await agent.detach();
    expect(agent.connection?.id).toBe("first");
    agent.connecting = false;
    agent.connection = undefined;
    await agent.detach();
    expect(runtime.request).not.toHaveBeenCalled();
    agent.dispose();
  });
  it("detaches a working thread without stopping it and saves its transcript", async () => {
    const { agent, runtime, listeners } = setup();
    runtime.request.mockResolvedValueOnce(agent.connection);
    await agent.newSession();
    listeners.get("acp.turnStarted")!({ id: "first", seq: 1, messageId: "m1", text: "wait" });
    expect(agent.busy).toBe(true);
    runtime.request.mockClear();
    await agent.detach();
    expect(methods(runtime)).toEqual(["acp.detach"]);
    expect(agent.connection).toBeUndefined();
    expect(agent.busy).toBe(false);
    expect(agent.messages).toEqual([]);
    expect(agent.title).toBe("New conversation");
    const saved = agent.history.entries.find((entry) => entry.title === "wait");
    expect(saved?.activity.map((item) => item.kind)).toEqual(["message", "notice"]);
    runtime.request.mockResolvedValueOnce({
      connection: { id: "first", root: "/w", provider: "codex", sessionId: "s1", authMethods: [] },
      busy: true, events: [], requests: [], queue: [], queuePaused: false, sequence: 1, truncated: false,
    });
    await agent.attachLive("first");
    await agent.saveConversation();
    expect(agent.history.entries.filter((entry) => entry.sessionId === "s1")).toHaveLength(1);
    agent.dispose();
  });
  it("names the device limit with the runtime message and loads the threads to stop", async () => {
    const { agent, runtime } = setup();
    agent.connection = undefined;
    const sessions = [live("a"), live("b", { busy: true }), live("c")];
    runtime.request.mockImplementation(async (method: string) => {
      if (method === "acp.start")
        throw Object.assign(new Error("3 agents are running for this device; stop one in Runtime sessions"), { code: "BUSY" });
      if (method === "acp.list") return { sessions };
      return {};
    });
    await expect(agent.connect({ provider: "codex" })).rejects.toThrow("3 agents are running for this device");
    expect(agent.status).toBe(AGENT_LIMIT_STATUS);
    await vi.waitFor(() => expect(agent.liveSessions).toHaveLength(3));
    expect(showThreads(agent)).toBe(true);
    await stopThread(agent, "b");
    expect(runtime.request).toHaveBeenCalledWith("acp.stop", { id: "b" });
    expect(agent.status).toBe("Disconnected");
    agent.dispose();
  });
  it("badges pending requests from background threads and reports each thread's state", async () => {
    const { agent, runtime, workbench } = setup();
    agent.busy = true;
    runtime.request.mockResolvedValueOnce({ sessions: [live("first"), live("second", { pendingRequests: 2 })] });
    await agent.listLiveSessions();
    expect(workbench.setViewBadge).toHaveBeenLastCalledWith("agent-acp", expect.objectContaining({ count: 2, tone: "attention" }));
    expect(agent.liveSessions.map((session) => threadState(agent, session).state)).toEqual(["working", "attention"]);
    expect(showThreads(agent)).toBe(true);
    agent.dispose();
  });
});
