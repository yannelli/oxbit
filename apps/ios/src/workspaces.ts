import { createWorkbenchSession, RuntimeFileSystem, type Session } from "@oxbit/app-workbench";
import { connectRuntime, runtimeScope } from "./runtime.js";
import {
  IosFileSystem,
  IosIconPackStore,
  IosPersistence,
  SESSION_SCOPE,
  forgetWorkspace,
  loadRecents,
  native,
  rememberWorkspace,
  type RecentWorkspace,
} from "@oxbit/host-ios";

export const DOCUMENTS_ID = "documents";
const LAST_KEY = "last-workspace";

export interface OpenWorkspace {
  recent: RecentWorkspace;
  session: Session;
}

export type OpenRequest =
  | { kind: "documents" }
  | { kind: "pick" }
  | { kind: "runtime"; url: string; code?: string }
  | { kind: "recent"; recent: RecentWorkspace };

const iconPackStore = new IosIconPackStore();

async function resolvePath(request: Exclude<OpenRequest, { kind: "runtime" }>): Promise<{ path: string; recent: Omit<RecentWorkspace, "lastOpened"> }> {
  if (request.kind === "documents" || (request.kind === "recent" && request.recent.kind === "documents"))
    return { path: await native.documentsPath(), recent: { id: DOCUMENTS_ID, kind: "documents", name: "Oxbit" } };
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
  const { path, recent } = await resolvePath(request);
  const filesystem = await IosFileSystem.open(path);
  const persistence = new IosPersistence(filesystem.id);
  let session: Session;
  try {
    session = await createWorkbenchSession({ filesystem, persistence, protectUnload: false, iconPackStore });
  } catch (error) {
    filesystem.dispose();
    if (recent.kind === "bookmark") await native.closeFolder(recent.id).catch(() => {});
    throw error;
  }
  const remembered = { ...recent, lastOpened: Date.now() };
  await rememberWorkspace(recent);
  await native.storageSet(SESSION_SCOPE, LAST_KEY, remembered.id);
  return { recent: remembered, session };
}

export async function closeWorkspace(workspace: OpenWorkspace) {
  await workspace.session.persist().catch(() => {});
  await workspace.session.dispose();
  if (workspace.recent.kind === "bookmark") await native.closeFolder(workspace.recent.id).catch(() => {});
}

export async function forgetRecent(id: string) {
  const recent = (await loadRecents()).find(item => item.id === id);
  const next = await forgetWorkspace(id);
  if (recent?.kind === "runtime" && recent.url) {
    if (!next.some(item => item.kind === "runtime" && item.url === recent.url))
      await native.runtimeCredentials({ operation: "forget", url: recent.url });
  } else if (id !== DOCUMENTS_ID) await native.forgetFolder(id).catch(() => {});
  if ((await native.storageGet<string>(SESSION_SCOPE, LAST_KEY)) === id) await native.storageSet(SESSION_SCOPE, LAST_KEY, null);
  return next;
}

export async function lastWorkspace(): Promise<RecentWorkspace | undefined> {
  const [last, recents] = await Promise.all([native.storageGet<string>(SESSION_SCOPE, LAST_KEY), loadRecents()]);
  return recents.find((item) => item.id === last);
}

export { loadRecents };
