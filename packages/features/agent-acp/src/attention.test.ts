import { describe, expect, it, vi } from "vitest";
import type { FeatureOptions } from "@oxbit/sdk";
import { AgentController } from "./controller.js";

function setup(visible: boolean | undefined) {
  const listeners = new Map<string, (params: any) => void>();
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
    openPanel: vi.fn(),
    setViewBadge: vi.fn(),
    panelVisible: visible === undefined ? undefined : vi.fn(() => visible),
  };
  const values: Record<string, string> = {};
  const options = {
    runtime,
    filesystem: { id: "fs" },
    documents: {},
    workbench,
    kernel: {
      configuration: {
        get: (id: string) => values[id],
        set: vi.fn(async (id: string, value: string) => {
          values[id] = value;
        }),
      },
    },
  } as unknown as FeatureOptions;
  const agent = new AgentController(options);
  agent.connection = { id: "c", root: "/w", provider: "codex", sessionId: "s", authMethods: [] };
  return { agent, listeners, workbench, runtime, values };
}

describe("agent attention", () => {
  it("badges pending requests and a finished turn while the panel is hidden", async () => {
    const { agent, listeners, workbench } = setup(false);
    listeners.get("acp.request")!({ id: "c", requestId: "r1", method: "session/request_permission", params: {} });
    await vi.waitFor(() => expect(agent.requests).toHaveLength(1));
    expect(workbench.setViewBadge).toHaveBeenLastCalledWith("agent-acp", expect.objectContaining({ count: 1, tone: "attention" }));
    expect(workbench.notify).toHaveBeenCalledWith("Agent needs your input", "info", expect.objectContaining({
      actions: [{ title: "Open Agent", command: "agentACP.open" }],
    }));
    listeners.get("acp.turnEnded")!({ id: "c", stopReason: "end_turn" });
    expect(workbench.setViewBadge).toHaveBeenLastCalledWith("agent-acp", expect.objectContaining({ count: 0, tone: "info" }));
    expect(workbench.notify).toHaveBeenLastCalledWith("Agent finished", "info", expect.anything());
    agent.markSeen();
    expect(workbench.setViewBadge).toHaveBeenLastCalledWith("agent-acp", undefined);
    agent.dispose();
  });
  it("stays quiet while the panel is visible or the host cannot tell", () => {
    for (const visible of [true, undefined]) {
      const { agent, listeners, workbench } = setup(visible);
      listeners.get("acp.turnEnded")!({ id: "c", stopReason: "end_turn" });
      expect(workbench.notify).not.toHaveBeenCalled();
      expect(workbench.setViewBadge).not.toHaveBeenCalledWith("agent-acp", expect.objectContaining({ count: 0 }));
      agent.dispose();
    }
  });
});

describe("agent selection and resume", () => {
  it("persists a registry choice and launches it by registry ID", async () => {
    const { agent, runtime, values } = setup(true);
    agent.connection = undefined;
    await agent.select({ provider: "opencode", registry: { id: "opencode" } });
    expect(values["agentACP.provider"]).toBe("opencode");
    runtime.request.mockRejectedValueOnce(new Error("Choose Codex, Cursor, or Amp"));
    await expect(agent.connectSelected()).rejects.toThrow(
      "This runtime does not support opencode. Update Oxbit on the runtime host.",
    );
    expect(runtime.request).toHaveBeenCalledWith(
      "acp.start",
      { provider: "opencode", registry: { id: "opencode" }, clientCapabilities: { editorTools: true } },
      expect.anything(),
    );
    agent.dispose();
  });
  it("resumes a saved custom agent with its stored launch", async () => {
    const { agent, runtime } = setup(true);
    agent.connection = undefined;
    runtime.request.mockRejectedValueOnce(new Error("offline"));
    await expect(
      agent.resumeSaved({
        id: "h", sessionId: "s", root: "/w", provider: "custom", name: "Mine",
        launch: { name: "Mine", command: "/bin/agent", args: ["--acp"] },
        title: "Saved", updatedAt: "", draft: "", context: [], activity: [], tools: [],
      }),
    ).rejects.toThrow("offline");
    expect(runtime.request).toHaveBeenCalledWith(
      "acp.start",
      expect.objectContaining({ provider: "custom", name: "Mine", command: "/bin/agent", args: ["--acp"] }),
      expect.anything(),
    );
    agent.dispose();
  });
});
