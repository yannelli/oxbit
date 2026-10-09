import { createWorkbenchSession, RuntimeClient, RuntimeFileSystem, type Session } from "@oxbit/app-workbench";
import { connectRuntime, runtimeScope } from "./runtime.js";
import { normalizePath } from "@oxbit/host-browser";
import {
  IosFileSystem,
  IosGitClient,
  IosIconPackStore,
  IosPersistence,
  SshFileSystem,
  createIosLanguageFeatures,
  migrateIosLanguageState,
  SESSION_SCOPE,
  forgetWorkspace,
  loadRecents,
  native,
  rememberWorkspace,
  ssh,
  type RecentWorkspace,
  type RemoteRuntimeEvent,
} from "@oxbit/host-ios";

export const DOCUMENTS_ID = "documents";
const LAST_KEY = "last-workspace";

export interface OpenWorkspace {
  recent: RecentWorkspace;
  session: Session;
  git?: IosGitClient;
  /** A runtime this app started on an SSH host; closing the workspace stops it. */
  remote?: { id: string; unlisten: () => void };
}

export type OpenRequest =
  | { kind: "documents"; directory?: string }
  | { kind: "pick" }
  | { kind: "runtime"; url: string; code?: string }
  | { kind: "ssh"; hostId: string; path: string; label: string }
  | { kind: "sshRuntime"; hostId: string; path: string; label: string; onEvent?: (event: RemoteRuntimeEvent) => void }
  | { kind: "recent"; recent: RecentWorkspace };

const iconPackStore = new IosIconPackStore();

async function resolvePath(request: Exclude<OpenRequest, { kind: "runtime" | "ssh" | "sshRuntime" }>): Promise<{ path: string; recent: Omit<RecentWorkspace, "lastOpened"> }> {
  if (request.kind === "documents" || (request.kind === "recent" && request.recent.kind === "documents")) {
    const directory = request.kind === "documents" ? request.directory : request.recent.directory;
    const relative = directory ? normalizePath(directory) : undefined;
    return {
      path: (await native.documentsPath()) + (relative ? "/" + relative : ""),
      recent: relative
        ? { id: DOCUMENTS_ID + ":" + relative, kind: "documents", name: relative.split("/").at(-1)!, directory: relative }
        : { id: DOCUMENTS_ID, kind: "documents", name: "Oxbit" },
    };
  }
  const folder = request.kind === "pick" ? await native.pickFolder() : await native.openFolder(request.recent.id);
  return { path: folder.path, recent: { id: folder.id, kind: "bookmark", name: folder.name } };
}

export async function openWorkspace(request: OpenRequest): Promise<OpenWorkspace> {
  if (request.kind === "runtime" || (request.kind === "recent" && request.recent.kind === "runtime")) {
    const url = request.kind === "runtime" ? request.url : request.recent.url;
    if (!url) throw new Error("This runtime address is missing. Connect to it again.");
    const runtime = await connectRuntime(url, request.kind === "runtime" ? request.code : undefined);
    let session: Session | undefined;
    try {
      const scope = await runtimeScope(runtime);
      const filesystem = new RuntimeFileSystem(runtime, scope);
      session = await createWorkbenchSession({ filesystem, runtime, persistence: new IosPersistence(scope), protectUnload: false, iconPackStore });
      const recent: RecentWorkspace = {
        id: "runtime:" + scope.slice(4), kind: "runtime", url: runtime.url,
        name: runtime.session?.workspaceName ?? new URL(runtime.url).hostname, lastOpened: Date.now(),
      };
      await rememberWorkspace(recent);
      await native.storageSet(SESSION_SCOPE, LAST_KEY, recent.id);
      return { recent, session };
    } catch (error) {
      if (session) await session.dispose();
      else runtime.dispose();
      throw error;
    }
  }
  if (request.kind === "ssh") return openSsh(request);
  if (request.kind === "sshRuntime") return openSshRuntime(request);
  if (request.kind === "recent" && (request.recent.kind === "ssh" || request.recent.kind === "sshRuntime"))
    throw new Error("Connect to this server again from Connect with SSH.");
  const { path, recent } = await resolvePath(request);
  const filesystem = await IosFileSystem.open(path);
  const persistence = new IosPersistence(filesystem.id);
  const git = new IosGitClient(filesystem.id);
  let session: Session | undefined;
  try {
    session = await createWorkbenchSession({ filesystem, git, persistence, protectUnload: false, preserveFilesystem: true, iconPackStore });
    const disabled = await migrateIosLanguageState(persistence);
    for (const languageFeature of createIosLanguageFeatures(filesystem)) {
      session.kernel.extensions.register(languageFeature);
      if (disabled.includes(languageFeature.manifest.id)) await session.kernel.extensions.disable(languageFeature.manifest.id);
      else await session.kernel.extensions.activate(languageFeature.manifest.id);
    }
    const remembered = { ...recent, lastOpened: Date.now() };
    await rememberWorkspace(recent);
    await native.storageSet(SESSION_SCOPE, LAST_KEY, remembered.id);
    return { recent: remembered, session, git };
  } catch (error) {
    await git.dispose();
    await session?.dispose();
    await filesystem.dispose();
    if (recent.kind === "bookmark") await native.closeFolder(recent.id).catch(() => {});
    throw error;
  }
}

/** The host must already be connected; the SSH connect dialog handles passwords and host keys. */
async function openSsh(request: Extract<OpenRequest, { kind: "ssh" }>): Promise<OpenWorkspace> {
  const filesystem = await SshFileSystem.connect(request.hostId, request.path);
  let session: Session | undefined;
  try {
    session = await createWorkbenchSession({
      filesystem, persistence: new IosPersistence(filesystem.id), protectUnload: false, preserveFilesystem: true, iconPackStore,
    });
    const recent: RecentWorkspace = {
      id: "ssh:" + filesystem.id.slice(4), kind: "ssh", name: `${request.label}: ${filesystem.name}`,
      hostId: request.hostId, remotePath: filesystem.root, lastOpened: Date.now(),
    };
    await rememberWorkspace(recent);
    await native.storageSet(SESSION_SCOPE, LAST_KEY, recent.id);
    return { recent, session };
  } catch (error) {
    await session?.dispose();
    await filesystem.dispose();
    throw error;
  }
}

/** The host must already be connected. Progress and reconnect events go to `onEvent`. */
async function openSshRuntime(request: Extract<OpenRequest, { kind: "sshRuntime" }>): Promise<OpenWorkspace> {
  const id = crypto.randomUUID();
  const unlisten = await ssh.onRuntime(id, event => request.onEvent?.(event));
  let runtime: RuntimeClient | undefined;
  let session: Session | undefined;
  try {
    const started = await ssh.runtimeStart(id, request.hostId, request.path);
    runtime = new RuntimeClient(started.url, "default", { token: started.token, persistToken: false });
    await runtime.connect();
    const scope = "ios:" + started.workspaceKey;
    session = await createWorkbenchSession({
      filesystem: new RuntimeFileSystem(runtime, scope), runtime, persistence: new IosPersistence(scope), protectUnload: false, iconPackStore,
    });
    if (started.openFile) await session.workbench.openFile(started.openFile, { preview: false });
    const recent: RecentWorkspace = {
      id: "sshRuntime:" + started.workspaceKey, kind: "sshRuntime", name: `${request.label}: ${started.root.split("/").at(-1) || started.root}`,
      hostId: request.hostId, remotePath: started.root, lastOpened: Date.now(),
    };
    await rememberWorkspace(recent);
    await native.storageSet(SESSION_SCOPE, LAST_KEY, recent.id);
    return { recent, session, remote: { id, unlisten } };
  } catch (error) {
    if (session) await session.dispose();
    else runtime?.dispose();
    unlisten();
    await ssh.runtimeStop(id).catch(() => {});
    throw error;
  }
}

export async function closeWorkspace(workspace: OpenWorkspace) {
  await workspace.session.persist().catch(() => {});
  try {
    await workspace.git?.dispose();
    await workspace.session.dispose();
  } finally {
    if (workspace.git || workspace.recent.kind === "ssh") await workspace.session.filesystem.dispose?.();
    if (workspace.recent.kind === "bookmark") await native.closeFolder(workspace.recent.id).catch(() => {});
    if (workspace.remote) {
      workspace.remote.unlisten();
      await ssh.runtimeStop(workspace.remote.id).catch(() => {});
    }
  }
}

export async function forgetRecent(id: string) {
  const recent = (await loadRecents()).find(item => item.id === id);
  const next = await forgetWorkspace(id);
  if (recent?.kind === "runtime" && recent.url) {
    if (!next.some(item => item.kind === "runtime" && item.url === recent.url))
      await native.runtimeCredentials({ operation: "forget", url: recent.url });
  } else if (recent?.kind === "bookmark") await native.forgetFolder(id).catch(() => {});
  if ((await native.storageGet<string>(SESSION_SCOPE, LAST_KEY)) === id) await native.storageSet(SESSION_SCOPE, LAST_KEY, null);
  return next;
}

export async function lastWorkspace(): Promise<RecentWorkspace | undefined> {
  const [last, recents] = await Promise.all([native.storageGet<string>(SESSION_SCOPE, LAST_KEY), loadRecents()]);
  return recents.find((item) => item.id === last);
}

export { loadRecents };
