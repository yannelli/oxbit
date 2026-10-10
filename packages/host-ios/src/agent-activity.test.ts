import { describe, expect, it, vi } from "vitest";
import { native } from "./native.js";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
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
});
