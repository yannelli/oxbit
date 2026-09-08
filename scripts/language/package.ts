import * as fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const tar = createRequire(require.resolve("../../apps/runtime/src/managed/install.ts"))("tar") as typeof import("../../apps/runtime/node_modules/tar");
const cache = process.env.OXBIT_LSP_CACHE;
if (!cache) throw new Error("Set OXBIT_LSP_CACHE to the smoke-test cache before packaging");
const output = process.env.OXBIT_LSP_BUNDLES ?? "evidence/language-milestone1/bundles";
await fs.mkdir(output, { recursive: true });
const records = [];
for (const name of (await fs.readdir(cache)).sort()) {
  // The proprietary server is always obtained directly from upstream, including in CI.
  if (name.startsWith("intelephense") || !/(?:darwin-arm64|linux-x64)$/.test(name)) continue;
  for (const digest of (await fs.readdir(path.join(cache, name))).sort()) {
    if (!/^[a-f0-9]{64}$/.test(digest)) continue;
    const directory = path.join(cache, name, digest);
    if (await fs.readFile(path.join(directory, ".complete"), "utf8") !== digest) throw new Error("Incomplete cache entry");
    const archive = `${name}-${digest}.tgz`;
    const names: string[] = [];
    async function walk(relative: string) {
      for (const name of (await fs.readdir(path.join(directory, relative))).sort()) {
        const file = path.join(relative, name); names.push(file);
        if ((await fs.lstat(path.join(directory, file))).isDirectory()) await walk(file);
      }
    }
    await walk("");
    await tar.c({ noDirRecurse: true, cwd: directory, file: path.join(output, archive), gzip: true, portable: true, mtime: new Date(0), noMtime: false }, names);
    const bytes = await fs.readFile(path.join(output, archive));
    records.push({ archive, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
}
await fs.writeFile(path.join(output, "integrity.json"), JSON.stringify(records, null, 2) + "\n");
