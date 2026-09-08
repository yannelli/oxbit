import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

/** Read an Oxbit runtime setting. */
export function setting(
  name: string,
  env: Record<string, string | undefined> = process.env,
) {
  return env[`OXBIT_${name}`];
}

/** Keep private runtime data in the Oxbit workspace directory. */
export function workspaceDataDir(root: string, home = os.homedir()) {
  const id = createHash("sha256").update(root).digest("hex").slice(0, 24);
  return path.join(home, ".oxbit", "workspaces", id);
}
