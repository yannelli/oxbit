import { describe, expect, it, vi } from "vitest";
import { native } from "./native.js";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  Channel: class {
    static next = 0;
    id = ++(this.constructor as { next: number }).next;
    constructor(public onmessage: (message: unknown) => void) {}
  },
}));
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

  it("watches notification taps through a channel and stops only its own channel", async () => {
    invoke.mockResolvedValue(undefined);
    const listener = vi.fn();
    const watch = await native.onNotificationTap(listener);
    const [command, args] = invoke.mock.calls.at(-1)!;
    expect(command).toBe("plugin:oxbit-files|watch_notification_taps");
    args.channel.onmessage({});
    expect(listener).toHaveBeenCalledOnce();
    await watch.unregister();
    expect(invoke.mock.calls.at(-1)).toEqual(["plugin:oxbit-files|unwatch_notification_taps", { id: args.channel.id }, undefined]);
  });
});
