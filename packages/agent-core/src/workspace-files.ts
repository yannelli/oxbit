import type { FileSystem } from "@oxbit/sdk";
import type { HostFiles } from "./instructions.js";

/** HostFiles over a workspace FileSystem mounted at the absolute `root`. Paths outside `root` read as missing. */
export function workspaceFiles(filesystem: FileSystem, root: string): HostFiles {
  const base = root.replace(/\/+$/, "") || "/";
  const inside = (path: string): string | undefined => {
    if (path.includes("\0")) return undefined;
    const trimmed = path.replace(/\/+$/, "") || "/";
    if (trimmed === base) return "";
    const prefix = base === "/" ? "/" : `${base}/`;
    if (!trimmed.startsWith(prefix)) return undefined;
    const parts = trimmed.slice(prefix.length).split("/");
    return parts.some((part) => part === "..") ? undefined : parts.filter((part) => part && part !== ".").join("/");
  };
  const list = async (path: string) => {
    const relative = inside(path);
    if (relative === undefined) return [];
    const entries = await filesystem.list(relative).catch(() => []);
    return entries.map((entry) => ({ name: entry.name, kind: entry.kind }));
  };
  return {
    list,
    async read(path) {
      const relative = inside(path);
      if (!relative) throw new Error(`${path} is outside the workspace`);
      return (await filesystem.read(relative)).text;
    },
    async exists(path) {
      const relative = inside(path);
      if (relative === undefined) return false;
      if (!relative) return true;
      const slash = path.replace(/\/+$/, "").lastIndexOf("/");
      const name = path.replace(/\/+$/, "").slice(slash + 1);
      return (await list(path.slice(0, slash) || "/")).some((entry) => entry.name === name);
    },
  };
}
