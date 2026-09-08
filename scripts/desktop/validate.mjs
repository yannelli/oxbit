import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
const root = fileURLToPath(new URL("../../", import.meta.url));
const native = path.join(root, "apps/desktop/src-tauri");
const bundleDirectory = path.join(
  path.resolve(native, process.env.CARGO_TARGET_DIR || "target"),
  "release/bundle",
);
const release = process.argv.includes("--release");
const cfg = JSON.parse(
  await fs.readFile(path.join(native, "tauri.conf.json"), "utf8"),
);
assert.equal(cfg.identifier, "com.yannelli.oxbit");
assert.equal(cfg.version, "../../../package.json");
assert.equal(cfg.bundle.macOS.minimumSystemVersion, "26.0");
assert(
  cfg.bundle.linux.deb.depends.includes("libc6 (>= 2.39)"),
  "Ubuntu 24.04 is the minimum supported Linux distribution",
);
assert(!JSON.stringify(cfg.app.security.capabilities).includes("native-tests"));
async function files(directory) {
  const result = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await files(file)));
    else result.push(file);
  }
  return result;
}
for (const file of await files(path.join(root, "apps/desktop/dist"))) {
  if (/\.(js|html)$/.test(file)) {
    const text = await fs.readFile(file, "utf8");
    assert(
      !/__oxbitDesktop|wdioTauri|WDIO Tauri Plugin|desktop_test_crash/.test(
        text,
      ),
      `Test access leaked into ${path.basename(file)}`,
    );
  }
}
const staged = path.join(native, "resources/runtime");
const inventory = JSON.parse(
  await fs.readFile(path.join(staged, "inventory.json"), "utf8"),
);
assert.equal(inventory.platform, `${process.platform}-${process.arch}`);
assert(
  inventory.rust?.some((pkg) => pkg.name === "tauri"),
  "Include Rust dependency notices",
);
assert(
  !inventory.rust.some((pkg) => pkg.name.includes("wdio")),
  "Native test drivers must not be included in release dependencies",
);
assert(
  inventory.frontend?.some((pkg) => pkg.name === "react"),
  "Include frontend dependency notices",
);
if (process.platform === "linux")
  assert(
    inventory.systemBuildPackages?.packages.some(
      (pkg) => pkg.name.startsWith("libwebkit2gtk-4.1-0") && pkg.notices,
    ),
    "Include notices for bundled Ubuntu system libraries",
  );
assert(inventory.packages.some((pkg) => pkg.name === "node-pty"));
assert(inventory.packages.some((pkg) => pkg.name === "typescript"));
assert(
  inventory.packages.some((pkg) => pkg.name === "typescript-language-server"),
);
for (const file of await files(staged))
  assert(
    !(await fs.lstat(file)).isSymbolicLink(),
    "Staged resources must not depend on symlinks",
  );
for (const binary of ["node", "rg"])
  assert((await fs.stat(path.join(staged, "bin", binary))).mode & 0o111);
const artifacts = await files(bundleDirectory);
const suffixes =
  process.platform === "darwin" ? [".dmg"] : [".deb", ".AppImage"];
for (const suffix of suffixes)
  assert(
    artifacts.some((file) => file.endsWith(suffix)),
    `Missing ${suffix} artifact`,
  );
if (release) {
  assert(
    process.env.OXBIT_UPDATER_PUBLIC_KEY,
    "Release build requires a public updater key",
  );
  for (const suffix of process.platform === "darwin"
    ? [".app.tar.gz.sig"]
    : [".AppImage.sig"])
    assert(
      artifacts.some((file) => file.endsWith(suffix)),
      `Missing ${suffix}`,
    );
  if (process.platform === "darwin") {
    const app = path.join(bundleDirectory, "macos/Oxbit.app");
    execFileSync(
      "/usr/bin/codesign",
      ["--verify", "--deep", "--strict", "--verbose=2", app],
      { stdio: "inherit" },
    );
    execFileSync(
      "/usr/sbin/spctl",
      ["--assess", "--type", "execute", "--verbose=2", app],
      { stdio: "inherit" },
    );
  }
}
console.log(
  JSON.stringify(
    {
      status: "passed",
      scope: release
        ? "Signed artifact structure and macOS app assessment; final DMG notarization is a separate step"
        : "Unsigned artifact structure; signing, Gatekeeper, and updates are not accepted",
      artifacts: artifacts
        .filter((file) => /\.(dmg|deb|AppImage|sig)$/.test(file))
        .map((file) => path.relative(root, file)),
    },
    null,
    2,
  ),
);
