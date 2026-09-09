import { createWorkbenchSession, type Session } from "@oxbit/app-workbench";
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
  | { kind: "recent"; recent: RecentWorkspace };

const iconPackStore = new IosIconPackStore();

async function resolvePath(request: OpenRequest): Promise<{ path: string; recent: Omit<RecentWorkspace, "lastOpened"> }> {
  if (request.kind === "documents" || (request.kind === "recent" && request.recent.kind === "documents"))
    return { path: await native.documentsPath(), recent: { id: DOCUMENTS_ID, kind: "documents", name: "Oxbit" } };
  const folder = request.kind === "pick" ? await native.pickFolder() : await native.openFolder(request.recent.id);
  return { path: folder.path, recent: { id: folder.id, kind: "bookmark", name: folder.name } };
}

export async function openWorkspace(request: OpenRequest): Promise<OpenWorkspace> {
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
  const next = await forgetWorkspace(id);
  if (id !== DOCUMENTS_ID) await native.forgetFolder(id).catch(() => {});
  if ((await native.storageGet<string>(SESSION_SCOPE, LAST_KEY)) === id) await native.storageSet(SESSION_SCOPE, LAST_KEY, null);
  return next;
}

export async function lastWorkspace(): Promise<RecentWorkspace | undefined> {
  const [last, recents] = await Promise.all([native.storageGet<string>(SESSION_SCOPE, LAST_KEY), loadRecents()]);
  return recents.find((item) => item.id === last);
}

export { loadRecents };
