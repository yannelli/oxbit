import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createSession: vi.fn(), openFilesystem: vi.fn(), disposeFilesystem: vi.fn(), disposeGit: vi.fn(),
  documentsPath: vi.fn(), pickFolder: vi.fn(), openFolder: vi.fn(), closeFolder: vi.fn(), forgetFolder: vi.fn(),
  storageGet: vi.fn(), storageSet: vi.fn(), credentials: vi.fn(),
  remember: vi.fn(), recents: vi.fn(), forget: vi.fn(), connect: vi.fn(), scope: vi.fn(),
  createLanguage: vi.fn(), registerLanguage: vi.fn(), activateLanguage: vi.fn(), persistenceGet: vi.fn(),
  sshConnect: vi.fn(),
}));
vi.mock("@oxbit/app-workbench", () => ({
  createWorkbenchSession: mocks.createSession,
  RuntimeFileSystem: class { constructor(readonly runtime: unknown, readonly id: string) {} },
}));
vi.mock("@oxbit/host-ios", () => ({
  IosFileSystem: { open: mocks.openFilesystem },
  IosGitClient: class {
    constructor(readonly id: string) {}
    dispose = mocks.disposeGit;
  },
  IosIconPackStore: class {},
  SshFileSystem: { connect: mocks.sshConnect },
  IosPersistence: class {
    constructor(readonly id: string) {}
    get = mocks.persistenceGet;
  },
  createIosLanguageFeature: mocks.createLanguage,
  SESSION_SCOPE: "session",
  loadRecents: mocks.recents, rememberWorkspace: mocks.remember, forgetWorkspace: mocks.forget,
  native: {
    documentsPath: mocks.documentsPath, pickFolder: mocks.pickFolder, openFolder: mocks.openFolder,
    closeFolder: mocks.closeFolder, forgetFolder: mocks.forgetFolder,
    storageGet: mocks.storageGet, storageSet: mocks.storageSet, runtimeCredentials: mocks.credentials,
  },
}));
vi.mock("./runtime.js", () => ({ connectRuntime: mocks.connect, runtimeScope: mocks.scope }));
import { closeWorkspace, forgetRecent, openWorkspace } from "./workspaces.js";

function sessionFor(filesystem: unknown, dispose = vi.fn().mockResolvedValue(undefined)) {
  return {
    filesystem,
    kernel: { extensions: { register: mocks.registerLanguage, activate: mocks.activateLanguage } },
    persist: vi.fn().mockResolvedValue(undefined),
    dispose,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.documentsPath.mockResolvedValue("/device/Documents");
  mocks.openFilesystem.mockResolvedValue({ id: "ios:repository", dispose: mocks.disposeFilesystem });
  mocks.createSession.mockImplementation(async ({ filesystem }) => sessionFor(filesystem));
  mocks.createLanguage.mockReturnValue({ manifest: { id: "oxbit.ios-language" } });
  mocks.activateLanguage.mockResolvedValue(undefined);
  mocks.persistenceGet.mockResolvedValue(undefined);
  mocks.disposeGit.mockResolvedValue(undefined);
  mocks.disposeFilesystem.mockResolvedValue(undefined);
  mocks.closeFolder.mockResolvedValue(undefined);
  mocks.recents.mockResolvedValue([]);
  mocks.forget.mockResolvedValue([]);
});

describe("native Git workspaces", () => {
  it("connects device folders to native Git without enabling runtime tools", async () => {
    const workspace = await openWorkspace({ kind: "documents" });
    const options = mocks.createSession.mock.calls[0]![0];
    expect(options.git).toBe(workspace.git);
    expect(options.git.id).toBe("ios:repository");
    expect(options.runtime).toBeUndefined();
    expect(options.preserveFilesystem).toBe(true);
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.createLanguage).toHaveBeenCalledWith(workspace.session.filesystem);
    expect(mocks.registerLanguage).toHaveBeenCalledWith(mocks.createLanguage.mock.results[0]!.value);
    expect(mocks.activateLanguage).toHaveBeenCalledWith("oxbit.ios-language");
  });
  it("keeps native Git available when device language servers are disabled", async () => {
    mocks.persistenceGet.mockResolvedValue(["oxbit.ios-language"]);
    const workspace = await openWorkspace({ kind: "documents" });
    expect(workspace.git).toBeDefined();
    expect(mocks.registerLanguage).toHaveBeenCalledOnce();
    expect(mocks.activateLanguage).not.toHaveBeenCalled();
  });
  it("opens and remembers a cloned repository under Documents", async () => {
    const workspace = await openWorkspace({ kind: "documents", directory: "projects/example" });
    expect(mocks.openFilesystem).toHaveBeenCalledWith("/device/Documents/projects/example");
    expect(workspace.recent).toMatchObject({ id: "documents:projects/example", kind: "documents", name: "example", directory: "projects/example" });
    await openWorkspace({ kind: "recent", recent: workspace.recent });
    expect(mocks.openFilesystem).toHaveBeenLastCalledWith("/device/Documents/projects/example");
    expect(mocks.openFolder).not.toHaveBeenCalled();
  });
  it("rejects cloned workspace paths that leave Documents", async () => {
    await expect(openWorkspace({ kind: "documents", directory: "../private" })).rejects.toThrow(/Invalid workspace path/);
    expect(mocks.openFilesystem).not.toHaveBeenCalled();
  });
  it("finishes Git work before closing the filesystem and bookmark scope", async () => {
    mocks.pickFolder.mockResolvedValue({ id: "bookmark", name: "Example", path: "/shared/Example" });
    const workspace = await openWorkspace({ kind: "pick" });
    const order: string[] = [];
    let release!: () => void;
    mocks.disposeGit.mockImplementation(() => new Promise<void>(resolve => { release = () => { order.push("git"); resolve(); }; }));
    vi.spyOn(workspace.session, "dispose").mockImplementation(async () => { order.push("session"); });
    mocks.disposeFilesystem.mockImplementation(async () => { order.push("filesystem"); });
    mocks.closeFolder.mockImplementation(async () => { order.push("bookmark"); });
    const closing = closeWorkspace(workspace);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect(order).toEqual([]);
    release();
    await closing;
    expect(order).toEqual(["git", "session", "filesystem", "bookmark"]);
  });
  it("closes native resources after workbench initialization fails", async () => {
    mocks.pickFolder.mockResolvedValue({ id: "bookmark", name: "Example", path: "/shared/Example" });
    mocks.createSession.mockRejectedValue(new Error("Cannot restore workspace"));
    await expect(openWorkspace({ kind: "pick" })).rejects.toThrow("Cannot restore workspace");
    expect(mocks.disposeGit).toHaveBeenCalledOnce();
    expect(mocks.disposeFilesystem).toHaveBeenCalledOnce();
    expect(mocks.closeFolder).toHaveBeenCalledWith("bookmark");
  });
  it("keeps connected computer workspaces on the runtime Git transport", async () => {
    const runtime = { url: "https://computer.test", session: { workspaceName: "Remote" }, dispose: vi.fn() };
    mocks.connect.mockResolvedValue(runtime);
    mocks.scope.mockResolvedValue("ios:remote");
    const workspace = await openWorkspace({ kind: "runtime", url: runtime.url });
    expect(mocks.createSession.mock.calls[0]![0]).toMatchObject({ runtime });
    expect(mocks.createSession.mock.calls[0]![0].git).toBeUndefined();
    expect(workspace.git).toBeUndefined();
    expect(mocks.createLanguage).not.toHaveBeenCalled();
  });
  it("closes Git and native resources when language server activation fails", async () => {
    mocks.activateLanguage.mockRejectedValue(new Error("Cannot activate device language servers"));
    await expect(openWorkspace({ kind: "documents" })).rejects.toThrow("Cannot activate device language servers");
    expect(mocks.disposeGit).toHaveBeenCalledOnce();
    expect(mocks.disposeFilesystem).toHaveBeenCalledOnce();
  });
  it("closes the session and native resources when remembering a workspace fails", async () => {
    const disposeSession = vi.fn();
    mocks.createSession.mockImplementation(async ({ filesystem }) => sessionFor(filesystem, disposeSession));
    mocks.remember.mockRejectedValue(new Error("Cannot save recent workspace"));
    await expect(openWorkspace({ kind: "documents" })).rejects.toThrow("Cannot save recent workspace");
    expect(disposeSession).toHaveBeenCalledOnce();
    expect(mocks.disposeGit).toHaveBeenCalledOnce();
    expect(mocks.disposeFilesystem).toHaveBeenCalledOnce();
  });
  it("forgetting a cloned repository removes its recent entry", async () => {
    mocks.recents.mockResolvedValue([{ id: "documents:example", kind: "documents", directory: "example", name: "example", lastOpened: 1 }]);
    await forgetRecent("documents:example");
    expect(mocks.forget).toHaveBeenCalledWith("documents:example");
    expect(mocks.forgetFolder).not.toHaveBeenCalled();
    expect(mocks.disposeFilesystem).not.toHaveBeenCalled();
  });
  it("opens an SFTP root without device Git or language servers and disposes it on close", async () => {
    const filesystem = { id: "ios:remote", name: "project", root: "/srv/project", dispose: mocks.disposeFilesystem };
    mocks.sshConnect.mockResolvedValue(filesystem);
    const workspace = await openWorkspace({ kind: "ssh", hostId: "host-1", path: "~/project", label: "Build box" });
    expect(mocks.sshConnect).toHaveBeenCalledWith("host-1", "~/project");
    const options = mocks.createSession.mock.calls[0]![0];
    expect(options).toMatchObject({ filesystem, preserveFilesystem: true });
    expect(options.git).toBeUndefined();
    expect(mocks.createLanguage).not.toHaveBeenCalled();
    expect(workspace.recent).toMatchObject({ id: "ssh:remote", kind: "ssh", name: "Build box: project", hostId: "host-1", remotePath: "/srv/project" });
    await closeWorkspace(workspace);
    expect(mocks.disposeFilesystem).toHaveBeenCalledOnce();
  });
  it("closes the SFTP root when the workbench cannot start", async () => {
    mocks.sshConnect.mockResolvedValue({ id: "ios:remote", name: "project", root: "/srv/project", dispose: mocks.disposeFilesystem });
    mocks.createSession.mockRejectedValue(new Error("Cannot restore workspace"));
    await expect(openWorkspace({ kind: "ssh", hostId: "host-1", path: "", label: "Box" })).rejects.toThrow("Cannot restore workspace");
    expect(mocks.disposeFilesystem).toHaveBeenCalledOnce();
  });
});
