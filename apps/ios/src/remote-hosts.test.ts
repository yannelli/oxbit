import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  storageGet: vi.fn(), storageSet: vi.fn(), openedUrls: vi.fn(), onOpenedUrl: vi.fn(), loadKey: vi.fn(), pair: vi.fn(),
  connect: vi.fn(), dispose: vi.fn(), created: [] as { record: { id: string; name: string }; options: Record<string, unknown> }[],
}));
vi.mock("@oxbit/workbench", () => {
  class RemoteHost {
    static pair = mocks.pair;
    status = () => ({ state: "idle" as const });
    subscribe = () => () => {};
    connect = mocks.connect;
    dispose = mocks.dispose;
    constructor(readonly record: { id: string; name: string }, readonly options: Record<string, unknown>) {
      mocks.created.push(this);
    }
    get id() { return this.record.id; }
  }
  return { RemoteHost, loadDeviceKey: mocks.loadKey, readPairingLink: vi.fn() };
});
vi.mock("@oxbit/host-ios", () => ({
  SESSION_SCOPE: "session",
  discovery: { watch: vi.fn() },
  remoteDeviceKeyStore: {},
  remoteHostAddress: (host: { host: string; port: number }) => `${host.host}:${host.port}`,
  native: { storageGet: mocks.storageGet, storageSet: mocks.storageSet, openedUrls: mocks.openedUrls, onOpenedUrl: mocks.onOpenedUrl },
}));
const { RemoteHosts, computerTarget, deviceName, openedPairingLink, watchOpenedLinks } = await import("./remote-hosts.js");

const studio = { id: "host-1", name: "Studio Mac", key: "k", relay: "wss://relay.test", pairedAt: 1, lastSeen: 50 };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.created.length = 0;
  mocks.storageSet.mockResolvedValue(undefined);
  mocks.loadKey.mockResolvedValue({ publicKey: new Uint8Array(32) });
  mocks.connect.mockResolvedValue(undefined);
});

describe("pairing links the system opens", () => {
  it("accepts the custom scheme and the oxbit.dev link and nothing else", () => {
    for (const link of ["oxbit://c#o=abc", "https://oxbit.dev/c#o=abc", "https://oxbit.dev/c/#o=abc"]) expect(openedPairingLink(link)).toBe(link);
    for (const link of ["oxbit://x#o=abc", "https://oxbit.dev/d#o=abc", "https://evil.test/c#o=abc", "oxbit://c#x=1", "not a url"])
      expect(openedPairingLink(link)).toBeUndefined();
  });

  it("drains queued URLs once listening starts and again on each event", async () => {
    let event!: () => void;
    const unlisten = vi.fn();
    mocks.onOpenedUrl.mockImplementation(async (listener: () => void) => { event = listener; return unlisten; });
    mocks.openedUrls.mockResolvedValueOnce(["https://example.test/", "oxbit://c#o=first"]).mockResolvedValueOnce(["https://oxbit.dev/c#o=second"]);
    const links: string[] = [];
    const stop = watchOpenedLinks(link => links.push(link));
    await vi.waitFor(() => expect(links).toEqual(["oxbit://c#o=first"]));
    event();
    await vi.waitFor(() => expect(links).toEqual(["oxbit://c#o=first", "https://oxbit.dev/c#o=second"]));
    stop();
    await vi.waitFor(() => expect(unlisten).toHaveBeenCalled());
  });
});

describe("paired computers", () => {
  it("names an iPad by its touch support", () => {
    expect(deviceName("Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X)", 5)).toBe("iPhone");
    expect(deviceName("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 5)).toBe("iPad");
  });

  it("maps presence to a Runtime target", () => {
    const host = { id: "host-1", record: studio, status: () => ({ state: "offline" as const, lastSeen: 99 }) };
    expect(computerTarget(host)).toMatchObject({ key: "computer:host-1", kind: "remote", name: "Studio Mac", hostId: "host-1", online: false, lastSeen: 99 });
    expect(computerTarget({ ...host, status: () => ({ state: "failed" as const, error: "Removed." }) })).toMatchObject({ online: undefined, lastSeen: 50, detail: "Removed." });
  });

  it("loads saved computers, connects each, and saves after pairing and forgetting", async () => {
    mocks.storageGet.mockResolvedValue([studio]);
    const hosts = new RemoteHosts();
    await hosts.load();
    expect(hosts.list().map(host => host.id)).toEqual(["host-1"]);
    expect(mocks.connect).toHaveBeenCalledOnce();
    expect(mocks.created[0]!.options).toMatchObject({ deviceName: expect.any(String) });

    const paired = { id: "host-2", record: { ...studio, id: "host-2", name: "Laptop" }, subscribe: () => () => {}, dispose: vi.fn() };
    mocks.pair.mockResolvedValue(paired);
    await hosts.pair({ h: "host-2" } as never);
    expect(hosts.list().map(host => host.id)).toEqual(["host-2", "host-1"]);
    expect(mocks.storageSet).toHaveBeenLastCalledWith("session", "remote-hosts", [paired.record, studio]);

    await hosts.forget("host-1");
    expect(mocks.dispose).toHaveBeenCalled();
    expect(mocks.storageSet).toHaveBeenLastCalledWith("session", "remote-hosts", [paired.record]);
  });

  it("tries Bonjour addresses for a host before the link's addresses", async () => {
    mocks.storageGet.mockResolvedValue([studio]);
    const hosts = new RemoteHosts();
    await hosts.load();
    hosts.setDiscovered([{ hostId: "host-1", name: "Studio Mac", host: "10.0.0.5", port: 7000 }]);
    const bonjour = mocks.created[0]!.options.bonjour as (id: string) => string[];
    expect(bonjour("host-1")).toEqual(["10.0.0.5:7000"]);
    expect(bonjour("other")).toEqual([]);
  });
});
