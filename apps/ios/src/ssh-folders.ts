import { SESSION_SCOPE, native } from "@oxbit/host-ios";

const HOME_FOLDERS_KEY = "ssh-home-folders";

/** The folder each saved host starts in, by host id; a host without one starts in `~`. */
export async function loadHomeFolders(): Promise<Record<string, string>> {
  const stored = await native.storageGet<Record<string, string>>(SESSION_SCOPE, HOME_FOLDERS_KEY).catch(() => null);
  return stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
}

export async function saveHomeFolder(hostId: string, path: string) {
  const next = { ...(await loadHomeFolders()), [hostId]: path };
  await native.storageSet(SESSION_SCOPE, HOME_FOLDERS_KEY, next);
  return next;
}

/** An absolute path for a folder field value, the way `ios_ssh_open_root` reads it. */
export function absoluteFolder(home: string, path: string) {
  const trimmed = path.trim();
  if (!trimmed || trimmed === "~") return home;
  if (trimmed.startsWith("/")) return normalizeFolder(trimmed);
  return normalizeFolder(`${home}/${trimmed.replace(/^~\//, "")}`);
}

function normalizeFolder(path: string) {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  return "/" + parts.join("/");
}

export function parentFolder(path: string) {
  return path.slice(0, path.lastIndexOf("/")) || "/";
}

export function childFolder(path: string, name: string) {
  return path === "/" ? `/${name}` : `${path}/${name}`;
}
