import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RecentWorkspace } from "@oxbit/host-ios";

const mocks = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const remote = {
    version: 0, list: [] as unknown[], listeners,
    hosts: {
      get version() { return remote.version; },
      list: () => remote.list, get: vi.fn(), setDiscovered: vi.fn(),
      subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    },
  };
  return { resume: vi.fn(), hosts: vi.fn(), remote, readLink: vi.fn() };
});
vi.mock("./remote-hosts.js", () => ({
  COMPUTER_PREFIX: "computer:",
  remoteHosts: mocks.remote.hosts,
  readPairingLink: mocks.readLink,
  computerTarget: (host: { id: string; name: string; online?: boolean }) => ({ key: "computer:" + host.id, kind: "remote", name: host.name, hostId: host.id, online: host.online }),
}));
vi.mock("@oxbit/host-ios", () => ({
  SESSION_SCOPE: "session",
  discovery: { watch: vi.fn() },
  native: { storageGet: vi.fn().mockResolvedValue(null), storageSet: vi.fn().mockResolvedValue(undefined) },
  ssh: { runtimeResume: mocks.resume, hosts: mocks.hosts },
}));
vi.mock("@oxbit/feature-runtime", async () => ({
  ...await import("../../../packages/features/runtime/src/store.js"),
  ...await import("../../../packages/features/runtime/src/configuration.js"),
}));
const { IosRuntimeConnector } = await import("./runtime-connector.js");
import type { OpenWorkspace } from "./workspaces.js";

const files: RecentWorkspace = { id: "ssh:files", kind: "ssh", name: "Build box: project", hostId: "host-1", remotePath: "/home/dev/project", lastOpened: 3 };
const remote: RecentWorkspace = { id: "sshRuntime:key", kind: "sshRuntime", name: "Build box: project", hostId: "host-1", remotePath: "/home/dev/project", lastOpened: 2 };
const laptop: RecentWorkspace = { id: "runtime:laptop", kind: "runtime", name: "laptop", url: "http://127.0.0.1:2", lastOpened: 4 };
const documents: RecentWorkspace = { id: "documents", kind: "documents", name: "Oxbit", lastOpened: 5 };

function workspace(recent: RecentWorkspace, runtime?: { connected: boolean; reconnect: () => Promise<void> }): OpenWorkspace {
  const configuration = { get: () => undefined, set: vi.fn(), subscribe: () => () => {} };
  return {
    recent,
    session: { kernel: { configuration }, runtime: runtime && { url: "http://127.0.0.1:9399", subscribe: () => () => {}, ...runtime } },
    ...recent.kind === "sshRuntime" ? { remote: { id: "remote-1", unlisten: vi.fn() } } : {},
  } as unknown as OpenWorkspace;
}

function setup(recents: RecentWorkspace[], open: RecentWorkspace | OpenWorkspace) {
  const connector = new IosRuntimeConnector();
  const startSsh = vi.fn();
  const host = { open: vi.fn(), close: vi.fn(), forget: vi.fn(), startSsh, manageSsh: vi.fn(), showRemote: vi.fn(), confirmPairing: vi.fn(), forgetRemote: vi.fn() };
  connector.host = host;
  connector.setRecents(recents);
  connector.attach("session" in open ? open : workspace(open));
  return { connector, startSsh, host };
}

beforeEach(() => {
  mocks.resume.mockReset();
  mocks.hosts.mockReset();
  mocks.remote.hosts.get.mockReset();
  mocks.remote.list = [];
});

describe("IosRuntimeConnector", () => {
  it("targets the open SFTP folder's host and folder", async () => {
    const { connector, startSsh } = setup([laptop, files], files);
    const target = connector.quickTarget()!;
    expect(target).toMatchObject({ kind: "ssh", hostId: "host-1", path: "/home/dev/project", name: "Build box: project" });
    await connector.connect(target);
    expect(startSsh).toHaveBeenCalledWith("host-1", "/home/dev/project");
  });

  it("reuses the saved runtime for the open SFTP folder", () => {
    const { connector } = setup([laptop, remote, files], files);
    expect(connector.quickTarget()).toMatchObject({ key: remote.id, kind: "ssh", path: remote.remotePath });
  });

  it("keeps the last connected runtime outside server folders", () => {
    const { connector } = setup([laptop, remote, documents], workspace(documents));
    expect(connector.quickTarget()).toMatchObject({ key: laptop.id, kind: "url" });
  });

  it("resumes the open remote runtime instead of opening the start dialog", async () => {
    const reconnect = vi.fn().mockResolvedValue(undefined);
    const { connector, startSsh } = setup([remote], workspace(remote, { connected: false, reconnect }));
    mocks.resume.mockResolvedValue({});
    await connector.connect(connector.quickTarget()!);
    expect(mocks.resume).toHaveBeenCalledWith("remote-1");
    expect(reconnect).toHaveBeenCalled();
    expect(startSsh).not.toHaveBeenCalled();
    expect(connector.status()).toMatchObject({ state: "reconnecting", progress: undefined });
  });

  it("reports a failed resume on the Runtime page", async () => {
    const { connector } = setup([remote], workspace(remote, { connected: false, reconnect: vi.fn() }));
    mocks.resume.mockRejectedValue(new Error("Could not connect to build.example.test"));
    await expect(connector.restart()).rejects.toThrow("Could not connect");
    expect(connector.status()).toMatchObject({ state: "failed", error: { message: "Could not connect to build.example.test" } });
  });

  it("fills a server's folder from the open workspace, then recents", async () => {
    mocks.hosts.mockResolvedValue([
      { id: "host-1", label: "Build box", username: "dev", hostname: "build.example.test", port: 22 },
      { id: "host-2", label: "Spare", username: "dev", hostname: "spare.example.test", port: 2222 },
    ]);
    const other = { ...remote, id: "sshRuntime:other", remotePath: "/srv/app" };
    const { connector } = setup([other, { ...files, hostId: "host-2", remotePath: "/home/dev/spare" }], files);
    expect(await connector.sshHosts()).toEqual([
      { id: "host-1", label: "Build box", detail: "dev@build.example.test", lastPath: "/home/dev/project" },
      { id: "host-2", label: "Spare", detail: "dev@spare.example.test:2222", lastPath: "/home/dev/spare" },
    ]);
  });
});

const folder: RecentWorkspace = { id: "remote:abc", kind: "remote", name: "Studio Mac: app", hostId: "host-1", remotePath: "/Users/dev/app", lastOpened: 6 };

describe("paired computers", () => {
  it("lists computers with presence and keeps the array until a host changes", () => {
    const { connector } = setup([], documents);
    mocks.remote.list = [{ id: "host-1", name: "Studio Mac", online: false }];
    mocks.remote.version++;
    const first = connector.computers();
    expect(first).toEqual([{ key: "computer:host-1", kind: "remote", name: "Studio Mac", hostId: "host-1", online: false }]);
    expect(connector.computers()).toBe(first);
    const listener = vi.fn();
    const off = connector.subscribe(listener);
    mocks.remote.version++;
    for (const notify of mocks.remote.listeners) notify();
    expect(listener).toHaveBeenCalled();
    expect(connector.computers()).not.toBe(first);
    off();
  });

  it("shows a computer's screen, opens its saved folders, and forgets either kind", async () => {
    const { connector, host } = setup([folder, laptop], documents);
    await connector.connect(connector.computers()[0] ?? { key: "computer:host-1", kind: "remote", name: "Studio Mac", hostId: "host-1" });
    expect(host.showRemote).toHaveBeenCalledWith("host-1");
    const saved = await connector.recents();
    expect(saved[0]).toMatchObject({ key: "remote:abc", kind: "remote", hostId: "host-1", path: "/Users/dev/app" });
    await connector.connect(saved[0]!);
    expect(host.open).toHaveBeenCalledWith({ kind: "remote", hostId: "host-1", path: "/Users/dev/app" });
    await connector.forget({ key: "computer:host-1", kind: "remote", name: "Studio Mac", hostId: "host-1" });
    expect(host.forgetRemote).toHaveBeenCalledWith("host-1");
    await connector.forget(saved[0]!);
    expect(host.forget).toHaveBeenCalledWith("remote:abc");
  });

  it("asks before pairing with a pasted link", async () => {
    const { connector, host } = setup([], documents);
    const offer = { h: "host-1", n: "Studio Mac" };
    mocks.readLink.mockResolvedValueOnce(offer).mockRejectedValueOnce(new Error("This pairing link is not valid."));
    await connector.pairLink("https://oxbit.dev/c#o=abc");
    expect(host.confirmPairing).toHaveBeenCalledWith(offer);
    await expect(connector.pairLink("nope")).rejects.toThrow("This pairing link is not valid.");
  });

  it("reconnects the computer, then the runtime, for the open remote folder", async () => {
    const order: string[] = [];
    const runtime = {
      connected: false,
      reconnect: vi.fn(async function (this: { connected: boolean }) {
        order.push("runtime");
        this.connected = true;
      }),
    };
    mocks.remote.hosts.get.mockReturnValue({ record: { name: "Studio Mac" }, reconnect: vi.fn(async () => { order.push("host"); }) });
    const { connector } = setup([folder], workspace(folder, runtime));
    expect(connector.status()).toMatchObject({ kind: "remote", host: "Studio Mac", workspace: "/Users/dev/app", targetKey: "remote:abc" });
    await connector.connect(connector.quickTarget()!);
    expect(order).toEqual(["host", "runtime"]);
    expect(connector.status()).toMatchObject({ state: "connected", progress: undefined });
  });

  it("passes Bonjour hosts from discovery to the paired computers", async () => {
    const { discovery } = await import("@oxbit/host-ios");
    const { connector } = setup([], documents);
    const listener = vi.fn();
    connector.discover(listener);
    const deliver = vi.mocked(discovery.watch).mock.calls.at(-1)![0];
    const hosts = [{ hostId: "host-1", name: "Studio Mac", host: "10.0.0.5", port: 7000 }];
    deliver([], false, hosts);
    expect(mocks.remote.hosts.setDiscovered).toHaveBeenCalledWith(hosts);
    expect(listener).toHaveBeenCalledWith([], false);
  });
});
