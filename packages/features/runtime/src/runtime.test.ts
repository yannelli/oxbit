import { describe, expect, it, vi } from "vitest";
import type { RuntimeConnector, RuntimeStatus, RuntimeTarget } from "@oxbit/workbench";
import { keepAliveMs, keepAliveOptions } from "./configuration.js";
import { RuntimeStatusStore, clientStatus, formatUptime, oneTap } from "./store.js";

const target: RuntimeTarget = { key: "url:abc12345", kind: "url", name: "studio", url: "http://192.168.1.5:50123", runtimeId: "abc12345" };

function connector(state: RuntimeStatus["state"], quick?: RuntimeTarget, connect = vi.fn(async () => {})): RuntimeConnector {
  return {
    status: () => ({ state }),
    subscribe: () => () => {},
    quickTarget: () => quick,
    connect,
    pair: vi.fn(),
    recents: async () => [],
  };
}

describe("keep-alive setting", () => {
  it("maps every option to milliseconds and falls back to the default", () => {
    expect(keepAliveOptions).toEqual(["75s", "15m", "1h", "8h", "untilStopped"]);
    expect(keepAliveMs("15m")).toBe(900_000);
    expect(keepAliveMs("untilStopped")).toBe(0);
    expect(keepAliveMs("bogus")).toBe(75_000);
    expect(keepAliveMs(undefined)).toBe(75_000);
  });
});

describe("one-tap cloud", () => {
  it("opens the page when connected", async () => {
    const open = vi.fn();
    const runtime = connector("connected", target);
    await oneTap(runtime, open);
    expect(open).toHaveBeenCalledOnce();
    expect(runtime.connect).not.toHaveBeenCalled();
  });
  it("connects to the known target without opening the page", async () => {
    const open = vi.fn();
    const runtime = connector("disconnected", target);
    await oneTap(runtime, open);
    expect(runtime.connect).toHaveBeenCalledWith(target);
    expect(open).not.toHaveBeenCalled();
  });
  it("opens the page when the connection fails", async () => {
    const open = vi.fn();
    await oneTap(connector("failed", target, vi.fn(async () => { throw new Error("refused"); })), open);
    expect(open).toHaveBeenCalledOnce();
  });
  it("opens the page when nothing is known or there is no connector", async () => {
    const open = vi.fn();
    await oneTap(connector("disconnected"), open);
    await oneTap(undefined, open);
    expect(open).toHaveBeenCalledTimes(2);
  });
});

describe("status store", () => {
  it("splits runtime output from a failure and notifies listeners", () => {
    const store = new RuntimeStatusStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.fail(new Error("Runtime startup failed\n--- runtime output ---\nError: Cannot find module 'node-pty'"));
    expect(store.get()).toMatchObject({ state: "failed", error: { message: "Runtime startup failed", detail: "Error: Cannot find module 'node-pty'" } });
    expect(listener).toHaveBeenCalledOnce();
  });
  it("describes a client from its URL and identity", () => {
    expect(clientStatus({
      url: "http://10.0.0.4:51234", connected: true,
      identity: { id: "abc12345", name: "studio", version: "0.4.2", startedAt: 1 },
      session: { trusted: true, owner: true, workspaceName: "oxbit" },
    }, "url")).toMatchObject({ host: "10.0.0.4", port: 51234, name: "studio", version: "0.4.2", runtimeId: "abc12345", workspace: "oxbit", trusted: true });
  });
  it("formats uptime", () => {
    expect(formatUptime(undefined)).toBeUndefined();
    expect(formatUptime(0, 30_000)).toBeUndefined();
    expect(formatUptime(1, 30_000)).toBe("<1m");
    expect(formatUptime(1, 1 + 125 * 60_000)).toBe("2h 5m");
    expect(formatUptime(1, 1 + 26 * 3_600_000)).toBe("1d 2h");
  });
});
