import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

const allowPnpm = new Set([
  "apps/web/src/seed.json",
  "examples/icon-packs/upstream.json",
  "packages/features/themes/src/classicos98.test.ts",
  "packages/features/themes/src/classicos98/associations.ts",
  "packages/features/themes/src/rainbow/associations.ts",
  "tests/package-manager.test.ts",
]);

const skipDirs = new Set([
  ".git",
  "node_modules",
  "dist",
  "target",
  "evidence",
  ".desktop-cache",
  ".audit",
]);

function walk(directory: string, files: string[]) {
  for (const name of readdirSync(directory)) {
    if (skipDirs.has(name)) continue;
    const full = path.join(directory, name);
    const relative = path.relative(root, full);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, files);
    else files.push(relative);
  }
}

describe("package manager contract", () => {
  it("pins Bun and records a bun lockfile", () => {
    const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    expect(manifest.packageManager).toBe("bun@1.4.2");
    expect(manifest.workspaces).toEqual([
      "apps/*",
      "packages/*",
      "packages/features/*",
      "examples/*",
    ]);
    expect(manifest.trustedDependencies).toEqual(["esbuild", "node-pty"]);
    expect(manifest.overrides["@xterm/addon-ligatures"]).toBe("0.11.0-beta.213");
    expect(manifest.pnpm).toBeUndefined();
    expect(existsSync(path.join(root, "bun.lock"))).toBe(true);
    expect(existsSync(path.join(root, "pnpm-lock.yaml"))).toBe(false);
    expect(existsSync(path.join(root, "pnpm-workspace.yaml"))).toBe(false);
  });

  it("keeps automation and contributor docs on bun", () => {
    const files: string[] = [];
    walk(root, files);
    const leftovers: string[] = [];
    for (const file of files) {
      if (allowPnpm.has(file)) continue;
      if (!/\.(md|json|jsonc|yml|yaml|ts|mts|js|mjs|cjs|sh|html)$/.test(file)) continue;
      const text = readFileSync(path.join(root, file), "utf8");
      if (/\bpnpm\b/.test(text)) leftovers.push(file);
    }
    expect(leftovers).toEqual([]);
  });
});
