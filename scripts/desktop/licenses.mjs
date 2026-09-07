import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
const root = fileURLToPath(new URL("../../", import.meta.url));
const stage = path.join(root, "apps/desktop/src-tauri/resources/runtime");
const inventoryFile = path.join(stage, "inventory.json");
const inventory = JSON.parse(await fs.readFile(inventoryFile, "utf8"));
async function notices(directory, destination, explicit) {
  await fs.mkdir(destination, { recursive: true });
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (
      entry.isFile() &&
      /^(licen[cs]e|copying|notice|copyright)([.-]|$)/i.test(entry.name)
    )
      await fs.copyFile(
        path.join(directory, entry.name),
        path.join(destination, entry.name),
      );
  }
  if (explicit)
    await fs.copyFile(explicit, path.join(destination, "declared-license.txt"));
}
// Frontend packages are bundled by Vite, but their attribution must travel with the app.
const frontend = new Map();
async function visit(directory) {
  const pkg = JSON.parse(
    await fs.readFile(path.join(directory, "package.json"), "utf8"),
  );
  const id = `${pkg.name}@${pkg.version}`;
  if (frontend.has(id)) return;
  frontend.set(id, {
    name: pkg.name,
    version: pkg.version,
    license: pkg.license || "SEE PACKAGE NOTICES",
  });
  await notices(
    directory,
    path.join(stage, "licenses/frontend", id.replaceAll("/", "_")),
  );
  const require = createRequire(path.join(directory, "package.json"));
  for (const name of Object.keys(pkg.dependencies || {})) {
    let resolved;
    for (const candidate of require.resolve.paths(name) || []) {
      try {
        resolved = await fs.realpath(path.join(candidate, name));
        break;
      } catch {
        /* Continue Node resolution. */
      }
    }
    if (!resolved)
      throw new Error(`Missing frontend license dependency: ${name}`);
    await visit(resolved);
  }
}
await visit(path.join(root, "apps/desktop"));
const native = path.join(root, "apps/desktop/src-tauri");
const triple =
  process.platform === "darwin"
    ? "aarch64-apple-darwin"
    : "x86_64-unknown-linux-gnu";
const metadata = JSON.parse(
  execFileSync(
    "cargo",
    [
      "metadata",
      "--locked",
      "--format-version",
      "1",
      "--filter-platform",
      triple,
    ],
    {
      cwd: native,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "inherit"],
    },
  ),
);
const included = new Set(metadata.resolve.nodes.map((node) => node.id));
const rust = [];
for (const pkg of metadata.packages.filter((pkg) => included.has(pkg.id))) {
  const directory = path.dirname(pkg.manifest_path);
  await notices(
    directory,
    path.join(stage, "licenses/rust", `${pkg.name}-${pkg.version}`),
    pkg.license_file,
  );
  rust.push({
    name: pkg.name,
    version: pkg.version,
    license: pkg.license || "SEE PACKAGE NOTICES",
  });
}
await fs.copyFile(
  path.join(root, "LICENSE"),
  path.join(stage, "licenses/OXBIT-LICENSE"),
);
inventory.frontend = [...frontend.values()].sort((a, b) =>
  a.name.localeCompare(b.name),
);
inventory.rust = rust.sort((a, b) => a.name.localeCompare(b.name));
if (process.platform === "linux") {
  // linuxdeploy can miss Debian notices when usrmerge makes /lib differ from
  // dpkg's /usr/lib paths. Include the build distribution's notices explicitly.
  // This is a documented superset, not a claim that every build package ships.
  const packages = execFileSync(
    "dpkg-query",
    ["-W", "-f=${binary:Package}\t${Version}\t${db:Status-Abbrev}\n"],
    { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
  );
  const system = [];
  for (const line of packages.trimEnd().split("\n")) {
    const [name, version, status] = line.split("\t");
    if (!status?.startsWith("ii")) continue;
    const copyright = `/usr/share/doc/${name.split(":")[0]}/copyright`;
    const destination = path.join("licenses/system", name, "copyright");
    const available = await fs.access(copyright).then(
      () => true,
      () => false,
    );
    if (available) {
      await fs.mkdir(path.dirname(path.join(stage, destination)), {
        recursive: true,
      });
      await fs.copyFile(copyright, path.join(stage, destination));
    }
    system.push({ name, version, notices: available ? destination : null });
  }
  await fs.cp(
    "/usr/share/common-licenses",
    path.join(stage, "licenses/common-licenses"),
    {
      recursive: true,
      dereference: true,
    },
  );
  inventory.systemBuildPackages = {
    scope:
      "Ubuntu build environment attribution superset, including bundled system libraries; not an installed application dependency list",
    packages: system,
  };
}
await fs.writeFile(inventoryFile, JSON.stringify(inventory, null, 2) + "\n");
console.log(
  `Packaged notices for ${frontend.size} frontend and ${rust.length} Rust packages`,
);
