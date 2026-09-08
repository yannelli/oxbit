import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { stageDependencies } from "./dependencies.mjs";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = fileURLToPath(new URL("../../", import.meta.url));
const pins = JSON.parse(
  await fs.readFile(new URL("./binaries.json", import.meta.url), "utf8"),
);
const platform = `${process.platform}-${process.arch}`;
const pin = pins[platform];
if (!pin)
  throw new Error(
    `Unsupported desktop build host: ${platform}. Build each target natively.`,
  );
const stage = path.join(root, "apps/desktop/src-tauri/resources/runtime");
const cache = path.join(root, ".desktop-cache");
await fs.mkdir(cache, { recursive: true });
const run = (command, args, options = {}) =>
  execFileSync(command, args, { cwd: root, stdio: "inherit", ...options });
async function download(binary) {
  const file = path.join(cache, path.basename(binary.url));
  try {
    await fs.access(file);
  } catch {
    // curl follows the GitHub asset redirect and fails on HTTP errors.
    run("curl", [
      "--fail",
      "--location",
      "--retry",
      "3",
      "--output",
      file + ".partial",
      binary.url,
    ]);
    await fs.rename(file + ".partial", file);
  }
  const digest = createHash("sha256")
    .update(await fs.readFile(file))
    .digest("hex");
  if (digest !== binary.sha256)
    throw new Error(
      `Checksum mismatch for ${path.basename(file)}. Remove the cached archive and retry.`,
    );
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "oxbit-unpack-"));
  run("tar", ["-xzf", file, "--strip-components=1", "-C", temp]);
  return temp;
}
const node = await download(pin.node);
const rg = await download(pin.rg);
try {
  run("pnpm", [
    "--filter",
    "@oxbit/runtime",
    "exec",
    "vite",
    "build",
    "--config",
    "vite.desktop.config.ts",
  ]);
  await fs.rm(stage, { recursive: true, force: true });
  await fs.mkdir(path.join(stage, "bin"), { recursive: true });
  await fs.mkdir(path.join(stage, "licenses"), { recursive: true });
  await fs.copyFile(path.join(node, "bin/node"), path.join(stage, "bin/node"));
  await fs.copyFile(path.join(rg, "rg"), path.join(stage, "bin/rg"));
  await fs.copyFile(
    path.join(node, "LICENSE"),
    path.join(stage, "licenses/node.txt"),
  );
  for (const name of ["COPYING", "LICENSE-MIT", "UNLICENSE"]) {
    try {
      await fs.copyFile(
        path.join(rg, name),
        path.join(stage, "licenses/ripgrep-" + name),
      );
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  await fs.cp(path.join(root, "apps/runtime/dist-desktop"), stage, {
    recursive: true,
  });
  await fs.writeFile(
    path.join(stage, "package.json"),
    JSON.stringify({
      name: "oxbit-desktop-runtime",
      private: true,
      type: "module",
    }),
  );
  const inventory = await stageDependencies(stage, path.join(root, "apps/runtime"));
  const prebuilds = path.join(stage, "node_modules/node-pty/prebuilds");
  try {
    for (const entry of await fs.readdir(prebuilds))
      if (entry !== platform)
        await fs.rm(path.join(prebuilds, entry), {
          recursive: true,
          force: true,
        });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  // node-pty's prebuild may omit +x. Repair before any signing takes place.
  async function inspect(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new Error(`Unexpected staged symlink: ${file}`);
      if (entry.isDirectory()) await inspect(file);
      else if (["spawn-helper", "node", "rg"].includes(entry.name))
        await fs.chmod(file, 0o755);
    }
  }
  await inspect(stage);
  await fs.writeFile(
    path.join(stage, "inventory.json"),
    JSON.stringify(
      {
        platform,
        node: pins.nodeVersion,
        ripgrep: pins.ripgrepVersion,
        downloads: pin,
        packages: inventory.sort((a, b) => a.name.localeCompare(b.name)),
      },
      null,
      2,
    ) + "\n",
  );
  await fs.copyFile(
    path.join(root, "THIRD_PARTY_NOTICES.md"),
    path.join(stage, "licenses/THIRD_PARTY_NOTICES.md"),
  );
  run(
    path.join(stage, "bin/node"),
    [
      "--input-type=module",
      "-e",
      "import pty from 'node-pty'; console.log('Packaged Node ' + process.version + '; PTY module loaded: ' + typeof pty.spawn)",
    ],
    { cwd: stage, env: { PATH: "/usr/bin:/bin", HOME: os.homedir() } },
  );
  run(process.execPath, ["scripts/remote/prepare.mjs", "--from-stage", stage]);
  console.log(`Desktop runtime staged at ${stage}`);
} finally {
  await fs.rm(node, { recursive: true, force: true });
  await fs.rm(rg, { recursive: true, force: true });
}
