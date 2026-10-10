import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => undefined }));

const { discovery, DISCOVERY_POLL_MS, native, ssh, rememberWorkspace } = await import("./index.js");
const DISCOVERY = "plugin:oxbit-files|runtime_discovery";
const mac = { runtimeId: "runtime-0123", name: "mac", version: "0.5.0", host: "192.168.1.10", port: 9277, url: "http://192.168.1.10:9277" };
const linux = { runtimeId: "runtime-4567", name: "linux", host: "192.168.1.11", port: 9277, url: "http://192.168.1.11:9277" };
const operations = () => invoke.mock.calls.filter(([command]) => command === DISCOVERY).map(([, args]) => args.request.operation);

beforeEach(() => {
  invoke.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("discovery.watch", () => {
  it("starts browsing, polls the list, delivers changes deduplicated by runtime ID, and stops on dispose", async () => {
    vi.useFakeTimers();
    const lists = [[mac], [mac, { ...mac, host: "fe80::1", url: "http://[fe80::1]:9277" }], [mac, linux]];
    invoke.mockImplementation(async (command: string, args?: { request: { operation: string } }) => {
      if (command !== DISCOVERY) throw new Error(`unexpected ${command}`);
      const operation = args!.request.operation;
      return { runtimes: operation === "list" ? lists.shift() ?? [mac, linux] : [] };
    });
    const seen: unknown[] = [];
    const dispose = discovery.watch((runtimes) => seen.push(runtimes));
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([[]]);
    for (let poll = 0; poll < 4; poll += 1) await vi.advanceTimersByTimeAsync(DISCOVERY_POLL_MS);
    expect(seen).toEqual([[], [mac], [mac, linux]]);
    dispose();
    dispose();
    await vi.advanceTimersByTimeAsync(DISCOVERY_POLL_MS * 3);
    expect(operations()).toEqual(["start", "list", "list", "list", "list", "stop"]);
    expect(invoke).toHaveBeenCalledWith(DISCOVERY, { request: { operation: "start" } });
  });

  it("reports Local Network denial until iOS allows browsing", async () => {
    vi.useFakeTimers();
    const states = [true, true, false];
    invoke.mockImplementation(async (_command: string, args: { request: { operation: string } }) =>
      args.request.operation === "start" ? { runtimes: [], localNetworkDenied: false } : { runtimes: states.shift() === false ? [mac] : [], localNetworkDenied: states.length > 0 });
    const seen: [unknown[], boolean][] = [];
    const dispose = discovery.watch((runtimes, denied) => seen.push([runtimes, denied]));
    for (let poll = 0; poll < 3; poll += 1) await vi.advanceTimersByTimeAsync(DISCOVERY_POLL_MS);
    dispose();
    expect(seen).toEqual([[[], false], [[], true], [[mac], false]]);
  });

  it("does not poll when browsing cannot start", async () => {
    vi.useFakeTimers();
    invoke.mockRejectedValue(new Error("Files app folders need iOS"));
    const listener = vi.fn();
    const dispose = discovery.watch(listener);
    await vi.advanceTimersByTimeAsync(DISCOVERY_POLL_MS * 3);
    dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(listener).not.toHaveBeenCalled();
    expect(operations()).toEqual(["start", "stop"]);
  });
});

describe("runtime bridge", () => {
  it("passes the runtime ID and health operation to native credentials", async () => {
    const runtime = { id: "runtime-0123", name: "mac", version: "0.5.0", startedAt: 1 };
    invoke.mockResolvedValueOnce({ token: "t", runtime });
    await expect(native.runtimeCredentials({ operation: "pair", url: mac.url, code: "123456" })).resolves.toEqual({ token: "t", runtime });
    invoke.mockResolvedValueOnce({ runtime });
    await expect(native.runtimeCredentials({ operation: "health", url: mac.url })).resolves.toEqual({ runtime });
    invoke.mockResolvedValueOnce({ token: "t" });
    await native.runtimeCredentials({ operation: "get", url: mac.url, runtimeId: runtime.id });
    expect(invoke.mock.calls.map(([command, args]) => [command, args])).toEqual([
      ["plugin:oxbit-files|runtime_credentials", { request: { operation: "pair", url: mac.url, code: "123456" } }],
      ["plugin:oxbit-files|runtime_credentials", { request: { operation: "health", url: mac.url } }],
      ["plugin:oxbit-files|runtime_credentials", { request: { operation: "get", url: mac.url, runtimeId: runtime.id } }],
    ]);
  });

  it("passes keepAlive to the SSH runtime start", async () => {
    invoke.mockResolvedValue({ url: "http://127.0.0.1:1", token: "t", workspaceKey: "k", root: "/~" });
    await ssh.runtimeStart("w1", "h1", "~/app", 0);
    await ssh.runtimeStart("w2", "h1", "~/app");
    expect(invoke.mock.calls[0]).toEqual(["ios_ssh_runtime_start", { id: "w1", hostId: "h1", path: "~/app", keepAlive: 0 }, undefined]);
    expect(invoke.mock.calls[1]![1].keepAlive).toBeUndefined();
  });
});

describe("recents by runtime ID", () => {
  const remember = async (stored: unknown[], entry: Parameters<typeof rememberWorkspace>[0]) => {
    invoke.mockResolvedValueOnce(stored).mockResolvedValueOnce(undefined);
    return rememberWorkspace(entry);
  };

  it("replaces an entry for the same runtime at a new port", async () => {
    const old = { id: "runtime:http://mac:9277", kind: "runtime" as const, name: "mac", url: "http://mac:9277", runtimeId: "runtime-0123", lastOpened: 1 };
    const other = { id: "runtime:http://linux:9277", kind: "runtime" as const, name: "linux", url: "http://linux:9277", runtimeId: "runtime-4567", lastOpened: 2 };
    const next = await remember([old, other], { id: "runtime:http://mac:9300", kind: "runtime", name: "mac", url: "http://mac:9300", runtimeId: "runtime-0123" });
    expect(next.map((item) => item.id)).toEqual(["runtime:http://mac:9300", "runtime:http://linux:9277"]);
  });

  it("keeps entries without a runtime ID apart", async () => {
    const legacy = [
      { id: "runtime:http://a:1", kind: "runtime" as const, name: "a", url: "http://a:1", lastOpened: 1 },
      { id: "runtime:http://b:1", kind: "runtime" as const, name: "b", url: "http://b:1", lastOpened: 2 },
    ];
    const next = await remember(legacy, { id: "runtime:http://c:1", kind: "runtime", name: "c", url: "http://c:1" });
    expect(next).toHaveLength(3);
  });
});
