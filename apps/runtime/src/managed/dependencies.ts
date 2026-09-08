import * as fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
/** Register installed dependency directories, including hoisted and package-store trees. */
export async function dependencyRoots(root: string, signal?: AbortSignal): Promise<string[]> {
  const roots = new Set<string>(), visited = new Set<string>(), queue = [{ directory: root, development: true }];
  while (queue.length && roots.size < 2000) {
    signal?.throwIfAborted();
    const { directory, development } = queue.shift()!;
    if (visited.has(directory)) continue; visited.add(directory);
    let manifest: any;
    try { manifest = JSON.parse(await fs.readFile(path.join(directory, "package.json"), "utf8")); } catch { continue; }
    const resolve = createRequire(path.join(directory, "package.json"));
    const names = Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies, ...(development ? manifest.devDependencies : {}) });
    for (const name of names.slice(0, 2000)) {
      signal?.throwIfAborted();
      if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)) continue;
      for (const base of resolve.resolve.paths(name) ?? []) {
        try {
          const installed = await fs.realpath(path.join(base, name));
          const pkg = JSON.parse(await fs.readFile(path.join(installed, "package.json"), "utf8"));
          if (pkg.name !== name || installed === path.parse(installed).root) break;
          if (!roots.has(installed)) { roots.add(installed); queue.push({ directory: installed, development: false }); }
          break;
        } catch { /* Optional packages and unavailable resolution candidates are skipped. */ }
      }
      if (roots.size >= 2000) break;
    }
  }
  return [...roots];
}
