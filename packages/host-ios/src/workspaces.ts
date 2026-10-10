import { native } from "./native.js";
import { SESSION_SCOPE } from "./persistence.js";

export interface RecentWorkspace {
  id: string;
  kind: "documents" | "bookmark" | "runtime" | "ssh" | "sshRuntime";
  name: string;
  url?: string;
  bookmark?: string;
  directory?: string;
  hostId?: string;
  remotePath?: string;
  /** The runtime's identity `id`; one recent per runtime survives a port change. */
  runtimeId?: string;
  lastOpened: number;
}
const RECENTS_KEY = "recents";
export const RECENTS_LIMIT = 20;

export async function loadRecents(): Promise<RecentWorkspace[]> {
  const stored = await native.storageGet<RecentWorkspace[]>(SESSION_SCOPE, RECENTS_KEY);
  return Array.isArray(stored) ? stored : [];
}
export async function rememberWorkspace(entry: Omit<RecentWorkspace, "lastOpened">): Promise<RecentWorkspace[]> {
  const replaced = (item: RecentWorkspace) =>
    item.id === entry.id || (entry.runtimeId !== undefined && item.runtimeId === entry.runtimeId) ||
    (entry.hostId !== undefined && item.kind === entry.kind && item.hostId === entry.hostId && item.remotePath === entry.remotePath);
  const next = [{ ...entry, lastOpened: Date.now() }, ...(await loadRecents()).filter((item) => !replaced(item))]
    .sort((a, b) => b.lastOpened - a.lastOpened)
    .slice(0, RECENTS_LIMIT);
  await native.storageSet(SESSION_SCOPE, RECENTS_KEY, next);
  return next;
}
export async function forgetWorkspace(id: string): Promise<RecentWorkspace[]> {
  const next = (await loadRecents()).filter((item) => item.id !== id);
  await native.storageSet(SESSION_SCOPE, RECENTS_KEY, next);
  return next;
}
