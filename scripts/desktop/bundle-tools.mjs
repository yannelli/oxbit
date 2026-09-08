import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
const pins = JSON.parse(
  await fs.readFile(new URL("./binaries.json", import.meta.url), "utf8"),
);
if (process.platform !== "linux" || process.arch !== "x64")
  throw new Error("Linux bundle helpers require x64 Linux");
const cache = path.join(
  process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"),
  "tauri",
);
await fs.mkdir(cache, { recursive: true });
for (const tool of pins.linuxBundleTools) {
  const file = path.join(cache, tool.file);
  try {
    await fs.access(file);
  } catch {
    execFileSync(
      "curl",
      [
        "--fail",
        "--location",
        "--retry",
        "3",
        "--output",
        file + ".partial",
        tool.url,
      ],
      { stdio: "inherit" },
    );
    await fs.rename(file + ".partial", file);
  }
  const hash = createHash("sha256")
    .update(await fs.readFile(file))
    .digest("hex");
  if (hash !== tool.sha256)
    throw new Error(
      `Checksum mismatch for ${tool.file}. Preserve/remove this cache entry and review the pinned upstream version before retrying.`,
    );
  await fs.chmod(file, 0o755);
}
const inventoryFile = new URL(
  "../../apps/desktop/src-tauri/resources/runtime/inventory.json",
  import.meta.url,
);
const inventory = JSON.parse(await fs.readFile(inventoryFile, "utf8"));
inventory.bundleTools = pins.linuxBundleTools;
await fs.writeFile(inventoryFile, JSON.stringify(inventory, null, 2) + "\n");
console.log(
  "Verified all Linux bundle helper checksums before Tauri packaging",
);
