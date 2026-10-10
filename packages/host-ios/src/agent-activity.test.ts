import { describe, expect, it, vi } from "vitest";
import { native } from "./native.js";

const { invoke, addPluginListener } = vi.hoisted(() => ({ invoke: vi.fn(), addPluginListener: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke, addPluginListener }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

describe("agent activity", () => {
  it("passes Live Activity updates to the plugin", async () => {
    invoke.mockResolvedValue({ enabled: true });
    const update = { agent: "Codex ACP", title: "Fix login", status: "working" as const, detail: "Working", pending: 0, startedAt: 5 };
    await expect(native.agentActivity(update)).resolves.toEqual({ enabled: true });
    await native.agentActivity(null);
    expect(invoke.mock.calls).toEqual([
      ["plugin:oxbit-files|live_activity", { update }, undefined],
      ["plugin:oxbit-files|live_activity", { update: null }, undefined],
    ]);
  });

  it("reports taps on posted notifications and ignores other actions", async () => {
    const listener = vi.fn();
    await native.onNotificationTap(listener);
    expect(addPluginListener).toHaveBeenCalledWith("notification", "actionPerformed", expect.any(Function));
    const handler = addPluginListener.mock.calls[0][2] as (event: { actionId: string }) => void;
    handler({ actionId: "dismiss" });
    expect(listener).not.toHaveBeenCalled();
    handler({ actionId: "tap" });
    expect(listener).toHaveBeenCalledOnce();
  });
});
