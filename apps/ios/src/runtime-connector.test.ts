import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RecentWorkspace } from "@oxbit/host-ios";

const mocks = vi.hoisted(() => ({ resume: vi.fn(), hosts: vi.fn() }));
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
  connector.host = { open: vi.fn(), close: vi.fn(), forget: vi.fn(), startSsh, manageSsh: vi.fn() };
  connector.setRecents(recents);
  connector.attach("session" in open ? open : workspace(open));
  return { connector, startSsh };
}

beforeEach(() => {
  mocks.resume.mockReset();
  mocks.hosts.mockReset();
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
