import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
if (process.platform !== "darwin")
  throw new Error("macOS signing requires a macOS host");
const identity = process.env.APPLE_SIGNING_IDENTITY;
if (!identity && process.argv.includes("--release"))
  throw new Error("APPLE_SIGNING_IDENTITY is required");
const directory = fileURLToPath(
  new URL("../../apps/desktop/src-tauri/resources/runtime/", import.meta.url),
);
const entitlements = fileURLToPath(
  new URL(
    "../../apps/desktop/src-tauri/NodeEntitlements.plist",
    import.meta.url,
  ),
);
const macho = new Set([
  "cffaedfe",
  "cefaedfe",
  "feedfacf",
  "feedface",
  "cafebabe",
  "bebafeca",
]);
let count = 0;
async function sign(dir) {
  for (const item of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, item.name);
    if (item.isDirectory()) await sign(file);
    else {
      const handle = await fs.open(file);
      const bytes = Buffer.alloc(4);
      await handle.read(bytes, 0, 4, 0);
      await handle.close();
      if (!macho.has(bytes.toString("hex"))) continue;
      // The shipping package contains only the target's native prebuilds.
      execFileSync(
        "/usr/bin/codesign",
        [
          "--force",
          "--sign",
          identity || "-",
          ...(identity ? ["--timestamp", "--options", "runtime"] : []),
          ...(item.name === "node" ? ["--entitlements", entitlements] : []),
          file,
        ],
        { stdio: "inherit" },
      );
      count++;
    }
  }
}
await sign(directory);
console.log(
  `Signed ${count} bundled native files (${identity ? "Developer ID" : "ad hoc development signing"}).`,
);
