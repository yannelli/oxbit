import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

/** Prefer the new name while allowing existing launch scripts to keep working. */
export function setting(
  name: string,
  env: Record<string, string | undefined> = process.env,
) {
  return env[`OXBIT_${name}`] ?? env[`ZAPP_${name}`];
}

/** Reuse an existing workspace in place, including its daemon and private data. */
export function workspaceDataDir(root: string, home = os.homedir()) {
  const id = createHash("sha256").update(root).digest("hex").slice(0, 24);
  const current = path.join(home, ".oxbit", "workspaces", id);
  const legacy = path.join(home, ".zapp", "workspaces", id);
  return !existsSync(current) && existsSync(legacy) ? legacy : current;
}
