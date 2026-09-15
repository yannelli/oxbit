import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
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
    if (item.isSymbolicLink()) continue;
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
// Notarization unpacks archives and rejects unsigned Mach-O files inside them,
// so the darwin remote payload is repacked around signed binaries. Its recorded
// sha256 gates the push to a remote host, so the manifest is rewritten too.
const remote = path.join(directory, "remote");
const manifestFile = path.join(remote, "manifest.json");
const manifest = JSON.parse(await fs.readFile(manifestFile, "utf8"));
let repacked = 0;
for (const platform of Object.keys(manifest.platforms)) {
  if (!platform.startsWith("darwin")) continue;
  const archive = path.join(remote, `${platform}.tar.gz`);
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), `oxbit-${platform}-`));
  try {
    execFileSync("tar", ["-xzf", archive, "-C", stage], { stdio: "inherit" });
    await sign(stage);
    execFileSync("tar", ["-czf", archive, "-C", stage, "."], {
      stdio: "inherit",
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    manifest.platforms[platform].sha256 = createHash("sha256")
      .update(await fs.readFile(archive))
      .digest("hex");
    repacked++;
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}
if (repacked)
  await fs.writeFile(manifestFile, JSON.stringify(manifest, null, 2) + "\n");
console.log(
  `Signed ${count} bundled native files in ${repacked} repacked remote payload(s) plus the runtime tree (${identity ? "Developer ID" : "ad hoc development signing"}).`,
);
