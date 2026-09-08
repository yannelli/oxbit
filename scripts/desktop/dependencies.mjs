import * as fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

// Hoist compatible versions, nesting conflicts at the requesting package. Preserve
// Node resolution without relying on a developer's pnpm store or flattening versions.
export async function stageDependencies(stage, runtime) {
  const copied = new Map();
  const inventory = [];
  async function copy(name, from, parent = stage, optional = false) {
    const require = createRequire(path.join(from, "package.json"));
    let source;
    for (const directory of require.resolve.paths(name) ?? []) {
      const candidate = path.join(directory, name, "package.json");
      try {
        source = path.dirname(await fs.realpath(candidate));
        break;
      } catch {
        /* Next resolution directory. */
      }
    }
    if (!source) {
      if (optional) return;
      throw new Error(`Missing production dependency: ${name}`);
    }
    const pkg = JSON.parse(
      await fs.readFile(path.join(source, "package.json"), "utf8"),
    );
    const hoisted = path.join(stage, "node_modules", name);
    const destination =
      copied.has(hoisted) && copied.get(hoisted) !== source
        ? path.join(parent, "node_modules", name)
        : hoisted;
    if (copied.has(destination)) {
      if (copied.get(destination) !== source)
        throw new Error(`Conflicting dependency at ${destination}`);
      return;
    }
    copied.set(destination, source);
    await fs.cp(source, destination, {
      recursive: true,
      dereference: true,
      filter: (entry) =>
        entry === source ||
        !path.relative(source, entry).split(path.sep).includes("node_modules"),
    });
    inventory.push({
      name,
      version: pkg.version,
      license: pkg.license ?? "SEE LICENSE IN PACKAGE",
      path: path.relative(stage, destination),
    });
    for (const dependency of Object.keys(pkg.dependencies ?? {}))
      await copy(dependency, source, destination);
    for (const dependency of Object.keys(pkg.optionalDependencies ?? {}))
      await copy(dependency, source, destination, true);
  }
  const pkg = JSON.parse(
    await fs.readFile(path.join(runtime, "package.json"), "utf8"),
  );
  for (const name of Object.keys(pkg.dependencies))
    if (!name.startsWith("@oxbit/")) await copy(name, runtime);
  return inventory.sort((a, b) => a.path.localeCompare(b.path));
}
