import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PUSH_RELAY_URL, type AgentActivityUpdate, type Disposable } from "@oxbit/sdk";
import { IosNotification } from "./notifications.js";
import { IosPush } from "./push.js";

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

type Channel = { onmessage: (message: unknown) => void };

function device({ permission = "granted", stored = {} as Record<string, unknown> } = {}) {
  const state = { permission, storage: new Map(Object.entries(stored)), channels: [] as Channel[], registrations: 0 };
  invoke.mockImplementation(async (command: string, args: Record<string, any> = {}) => {
    switch (command) {
      case "plugin:oxbit-files|notification_permission":
        return { permission: state.permission };
      case "plugin:oxbit-files|request_notification_permission":
        state.permission = "granted";
        return { permission: state.permission };
      case "plugin:oxbit-files|register_remote_notifications":
        state.registrations++;
        return { token: "a1b2c3", environment: "production" };
      case "plugin:oxbit-files|watch_live_activity_tokens":
        state.channels.push(args.channel);
        return;
      case "ios_storage_get":
        return state.storage.get(`${args.scope}:${args.key}`) ?? null;
      case "ios_storage_set":
        state.storage.set(`${args.scope}:${args.key}`, args.value);
        return;
    }
    throw new Error(`Unexpected native command ${command}`);
  });
  return state;
}

function runtime(answer: (method: string) => unknown = () => ({})) {
  const listeners = new Set<(change: { state: string }) => void>();
  return {
    connected: true,
    request: vi.fn(async (method: string, _params?: Record<string, unknown>) => {
      const result = answer(method);
      if (result instanceof Error) throw result;
      return result;
    }),
    subscribe: vi.fn((_event: string, listener: (change: { state: string }) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    emit: (state: string) => listeners.forEach((listener) => listener({ state })),
  };
}

function relay() {
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    const { kind } = JSON.parse(String(init.body)) as { kind: string };
    return new Response(JSON.stringify({ handle: `sealed-${kind}` }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const page = Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState });
function setVisibility(state: DocumentVisibilityState) {
  page.visibilityState = state;
  page.dispatchEvent(new Event("visibilitychange"));
}

const unknownMethod = () => Object.assign(new Error("Unknown runtime method push.register"), { code: "METHOD_NOT_FOUND" });
const working: AgentActivityUpdate = { agent: "Codex ACP", title: "Fix login", status: "working", detail: "Working", pending: 0, startedAt: 5000 };
const attached: Disposable[] = [];
function attach(push: IosPush, client: ReturnType<typeof runtime>, activity: () => AgentActivityUpdate | null = () => null) {
  attached.push(push.attach(client, activity));
}

describe("iOS push registration", () => {
  beforeEach(() => {
    page.visibilityState = "visible";
    vi.stubGlobal("document", page);
  });
  afterEach(() => {
    attached.splice(0).forEach((disposable) => disposable.dispose());
    invoke.mockReset();
    IosNotification.permission = "default";
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("posts the APNs token to the relay and registers the handle with the runtime", async () => {
    const native = device();
    const fetch = relay();
    const client = runtime();
    attach(new IosPush(), client);
    await vi.waitFor(() => expect(client.request).toHaveBeenCalledWith("push.state", expect.anything()));
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`${PUSH_RELAY_URL}/v1/devices`);
    expect(init).toMatchObject({ method: "POST", headers: { "Content-Type": "application/json" } });
    expect(JSON.parse(String(init.body))).toEqual({ token: "a1b2c3", environment: "production", kind: "alert" });
    const deviceId = native.storage.get("session:push-device");
    expect(deviceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(client.request.mock.calls).toEqual([
      ["push.register", { deviceId, alert: "sealed-alert", liveActivity: undefined }],
      ["push.state", { deviceId, active: true }],
    ]);
  });

  it("waits for notification permission and registers right after a grant", async () => {
    const native = device({ permission: "default" });
    const fetch = relay();
    const client = runtime();
    attach(new IosPush(), client);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("plugin:oxbit-files|notification_permission"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(native.registrations).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(client.request).not.toHaveBeenCalled();

    await expect(IosNotification.requestPermission()).resolves.toBe("granted");
    await vi.waitFor(() => expect(client.request).toHaveBeenCalledWith("push.register", expect.objectContaining({ alert: "sealed-alert" })));
  });

  it("registers again with both handles when a Live Activity token arrives", async () => {
    const native = device();
    const fetch = relay();
    const client = runtime();
    attach(new IosPush("https://relay.test"), client);
    await vi.waitFor(() => expect(native.channels).toHaveLength(1));
    native.channels[0]!.onmessage({ token: "feed01" });
    await vi.waitFor(() => expect(client.request).toHaveBeenCalledWith("push.register", expect.objectContaining({ liveActivity: "sealed-liveactivity" })));
    expect(fetch.mock.calls.map(([url, init]) => [url, JSON.parse(String(init.body))])).toEqual([
      ["https://relay.test/v1/devices", { token: "a1b2c3", environment: "production", kind: "alert" }],
      ["https://relay.test/v1/devices", { token: "feed01", environment: "production", kind: "liveactivity" }],
    ]);
    expect(client.request).toHaveBeenLastCalledWith("push.state", expect.anything());
    expect(client.request.mock.calls.filter(([method]) => method === "push.register").at(-1)?.[1]).toMatchObject({
      alert: "sealed-alert",
      liveActivity: "sealed-liveactivity",
    });

    const calls = client.request.mock.calls.length;
    native.channels[0]!.onmessage({ token: "feed01" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(client.request.mock.calls).toHaveLength(calls);
  });

  it("reports hidden with the latest activity and visible without one", async () => {
    device();
    relay();
    const client = runtime();
    let activity: AgentActivityUpdate | null = null;
    attach(new IosPush(), client, () => activity);
    await vi.waitFor(() => expect(client.request).toHaveBeenCalledWith("push.state", expect.anything()));
    const deviceId = client.request.mock.calls[0]![1]!.deviceId;
    client.request.mockClear();

    activity = working;
    setVisibility("hidden");
    await vi.waitFor(() => expect(client.request).toHaveBeenCalledWith("push.state", { deviceId, active: false, activity: working }));
    setVisibility("visible");
    await vi.waitFor(() => expect(client.request).toHaveBeenLastCalledWith("push.state", { deviceId, active: true }));
  });

  it("treats an unknown push method as a runtime without push until it reconnects, without logging", async () => {
    device();
    relay();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = runtime((method) => (method.startsWith("push.") ? unknownMethod() : {}));
    attach(new IosPush(), client);
    await vi.waitFor(() => expect(client.request).toHaveBeenCalledWith("push.register", expect.anything()));
    setVisibility("hidden");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(client.request).toHaveBeenCalledOnce();

    client.emit("connected");
    await vi.waitFor(() => expect(client.request).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(client.request.mock.calls.map(([method]) => method)).toEqual(["push.register", "push.register"]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("registers again after the runtime reconnects and skips state while disconnected", async () => {
    device();
    relay();
    const client = runtime();
    attach(new IosPush(), client);
    await vi.waitFor(() => expect(client.request).toHaveBeenCalledWith("push.state", expect.anything()));
    client.request.mockClear();

    client.connected = false;
    client.emit("disconnected");
    setVisibility("hidden");
    setVisibility("visible");
    client.connected = true;
    client.emit("connected");
    await vi.waitFor(() => expect(client.request).toHaveBeenCalledTimes(2));
    expect(client.request.mock.calls.map(([method, params]) => [method, params?.active])).toEqual([
      ["push.register", undefined],
      ["push.state", true],
    ]);
  });

  it("reuses the stored device ID and cached handles across launches", async () => {
    const stored = {
      "session:push-device": "device-1",
      "session:push-handles": { alert: { token: "a1b2c3", environment: "production", handle: "cached-alert" } },
    };
    device({ stored });
    const fetch = relay();
    const client = runtime();
    attach(new IosPush(), client);
    await vi.waitFor(() =>
      expect(client.request).toHaveBeenCalledWith("push.register", { deviceId: "device-1", alert: "cached-alert", liveActivity: undefined }),
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("posts a changed token again and logs relay failures without registering", async () => {
    const native = device({ stored: { "session:push-handles": { alert: { token: "old", environment: "production", handle: "stale" } } } });
    const fetch = vi.fn(async () => new Response("unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = runtime();
    attach(new IosPush(), client);
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith("Push registration failed", expect.any(Error)));
    expect(fetch).toHaveBeenCalledOnce();
    expect(client.request).not.toHaveBeenCalled();
    expect(native.storage.get("session:push-handles")).toEqual({ alert: { token: "old", environment: "production", handle: "stale" } });
  });
});
