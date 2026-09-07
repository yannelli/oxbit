import { chmodSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

// node-pty 1.1.0 ships macOS prebuild helpers with mode 0644. Repair the
// installed files after install and before build/start, including when install
// scripts were skipped. Resolve from the runtime so pnpm's layout also works.
if (process.platform === "darwin") {
  const require = createRequire(
    new URL("../apps/runtime/package.json", import.meta.url),
  );
  const directory = path.dirname(require.resolve("node-pty/package.json"));
  const candidates = [
    "build/Release",
    "build/Debug",
    "prebuilds/darwin-arm64",
    "prebuilds/darwin-x64",
  ];
  let found = false;
  for (const candidate of candidates) {
    const helper = path.join(directory, candidate, "spawn-helper");
    let stat;
    try {
      stat = statSync(helper);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    found = true;
    if ((stat.mode & 0o111) === 0o111) continue;
    try {
      chmodSync(helper, (stat.mode & 0o777) | 0o111);
    } catch (error) {
      throw new Error(
        `Cannot make node-pty's helper executable: ${helper}. Check ownership and permissions.`,
        { cause: error },
      );
    }
    console.log(`[oxbit] Repaired execute permissions: ${helper}`);
  }
  if (!found) {
    throw new Error(
      `node-pty's spawn-helper is missing from ${directory}. Reinstall dependencies before starting terminals.`,
    );
  }
}
