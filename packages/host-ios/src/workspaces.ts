import { native } from "./native.js";
import { SESSION_SCOPE } from "./persistence.js";

export interface RecentWorkspace {
  id: string;
  kind: "documents" | "bookmark" | "runtime";
  name: string;
  url?: string;
  bookmark?: string;
  lastOpened: number;
}
const RECENTS_KEY = "recents";
export const RECENTS_LIMIT = 20;

export async function loadRecents(): Promise<RecentWorkspace[]> {
  const stored = await native.storageGet<RecentWorkspace[]>(SESSION_SCOPE, RECENTS_KEY);
  return Array.isArray(stored) ? stored : [];
}
export async function rememberWorkspace(entry: Omit<RecentWorkspace, "lastOpened">): Promise<RecentWorkspace[]> {
  const next = [{ ...entry, lastOpened: Date.now() }, ...(await loadRecents()).filter((item) => item.id !== entry.id)]
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
