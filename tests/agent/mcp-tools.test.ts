import { afterEach, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import * as fs from "node:fs";
// @ts-expect-error plain-node MCP modules without types
import { globToRegExp, parseWorkflow, runsOnPullRequest, runsOnThisHost } from "../../scripts/agent/mcp/workflows.mjs";
// @ts-expect-error plain-node MCP modules without types
import { checksForPaths } from "../../scripts/agent/mcp/checks.mjs";
// @ts-expect-error plain-node MCP modules without types
import { docsForPaths, packageDir, parseIndex } from "../../scripts/agent/mcp/docs.mjs";
// @ts-expect-error plain-node MCP modules without types
import { createHandler } from "../../scripts/agent/mcp/rpc.mjs";

const temps: string[] = [];

function tempRoot(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oxbit-mcp-tools-"));
  temps.push(root);
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), text);
  }
  return root;
}

afterEach(() => {
  for (const root of temps.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const EVERY_PR = `name: Desktop
on:
  pull_request:
  workflow_dispatch:
jobs:
  build:
    strategy:
      matrix:
        include:
          - runner: macos-26
    steps:
      - uses: actions/checkout@v4
      - run: bun install --frozen-lockfile
      - name: Checks
        run: |
          bun run lint
          bun run typecheck
          bun run test
      - uses: actions/upload-artifact@v4
        with:
          name: not-a-step-name
      - name: Linux only
        if: runner.os == 'Linux'
        run: xvfb-run -a bun run desktop:test:native
      - name: Rust
        run: bun run desktop:check
`;

const FILTERED = `name: npm
on:
  push:
    branches: [main]
  pull_request:
    paths:
      - "scripts/npm/**"
      - 'packages/sdk/**'
jobs:
  check:
    if: github.event_name == 'pull_request'
    steps:
      - run: node scripts/npm/publish.mjs sdk --dry-run
  publish:
    if: github.event_name != 'pull_request'
    steps:
      - run: node scripts/npm/publish.mjs sdk
`;

describe("workflow scanner", () => {
  it("reads path filters, jobs and run steps", () => {
    const filtered = parseWorkflow("npm.yml", FILTERED);
    expect(filtered).toMatchObject({ pullRequest: true, paths: ["scripts/npm/**", "packages/sdk/**"] });
    expect(filtered.jobs.map((job: any) => [job.id, runsOnPullRequest(job)])).toEqual([["check", true], ["publish", false]]);

    const everyPr = parseWorkflow("desktop.yml", EVERY_PR);
    expect(everyPr).toMatchObject({ pullRequest: true, paths: null });
    const steps = everyPr.jobs[0].steps;
    expect(steps).toHaveLength(6);
    expect(steps[2]).toEqual({ name: "Checks", if: null, run: "bun run lint\nbun run typecheck\nbun run test" });
    expect(steps[3].name).toBeNull();
    expect(runsOnThisHost(steps[4], "darwin")).toBe(false);
    expect(runsOnThisHost(steps[4], "linux")).toBe(true);
  });

  it("matches GitHub path globs", () => {
    expect(globToRegExp("apps/runtime/src/lsp*").test("apps/runtime/src/lsp-manager.ts")).toBe(true);
    expect(globToRegExp("apps/runtime/src/lsp*").test("apps/runtime/src/lsp/x.ts")).toBe(false);
    expect(globToRegExp("packages/sdk/**").test("packages/sdk/src/a/b.ts")).toBe(true);
    expect(globToRegExp("**/*.css").test("a.css")).toBe(true);
    expect(globToRegExp("apps/agent/README.md").test("apps/agent/READMExmd")).toBe(false);
  });
});

describe("checks_for_paths", () => {
  const files = {
    ".github/workflows/desktop.yml": EVERY_PR,
    ".github/workflows/npm.yml": FILTERED,
    "package.json": JSON.stringify({ scripts: { "desktop:check": "node scripts/desktop/run.mjs check" } }),
  };

  it("returns path-filtered workflow commands and the every-PR checks for the paths", () => {
    const root = tempRoot(files);
    const result = checksForPaths(root, ["packages/sdk/src/index.ts", "apps/desktop/src-tauri/src/main.rs", "packages/features/themes/src/manager.tsx"], { platform: "darwin" });
    const byCommand = Object.fromEntries(result.focused.map((entry: any) => [entry.command, entry]));
    expect(byCommand["node scripts/npm/publish.mjs sdk --dry-run"].paths).toEqual(["packages/sdk/src/index.ts"]);
    expect(byCommand["node scripts/npm/publish.mjs sdk"]).toBeUndefined();
    expect(byCommand["node scripts/theme-coverage.mjs --check"].paths).toEqual(["packages/features/themes/src/manager.tsx"]);
    expect(byCommand["bun run desktop:check"]).toMatchObject({ paths: ["apps/desktop/src-tauri/src/main.rs"], script: "node scripts/desktop/run.mjs check" });
    expect(byCommand["bun run lint"].paths).toHaveLength(2);
    const desktop = result.workflows.find((workflow: any) => workflow.file.endsWith("desktop.yml"));
    expect(desktop.commands.map((entry: any) => entry.command)).toEqual(["bun run lint\nbun run typecheck\nbun run test", "bun run desktop:check"]);
  });

  it("skips filtered workflows with no matching path and reports hand-map drift", () => {
    const root = tempRoot({ ...files, ".github/workflows/desktop.yml": EVERY_PR.replace("bun run desktop:check", "cargo clippy") });
    const result = checksForPaths(root, ["apps/desktop/src-tauri/src/main.rs"], { platform: "darwin" });
    expect(result.skipped).toEqual([{ file: ".github/workflows/npm.yml", reason: "no path matches its pull_request.paths filter" }]);
    expect(result.drift.map((entry: any) => entry.id)).toContain("desktop-rust");
    expect(result.focused.map((entry: any) => entry.command)).not.toContain("bun run desktop:check");
  });
});

describe("docs_for_paths", () => {
  it("finds INDEX rows, path mentions and package mentions", () => {
    const root = tempRoot({
      "docs/INDEX.md": "| Guide | Use when |\n| --- | --- |\n| [Themes](themes.md) | Changing `packages/features/themes` |\n| [Audit](security.md#audit) | Audits |\n",
      "docs/themes.md": "# Themes\n",
      "docs/editor.md": "See `packages/features/themes/src/manager.tsx:12`.\n",
      "docs/other.md": "Mentions packages/features/themes-extra only.\n",
      "docs/agents/ledgers/follow-ups.md": "packages/features/themes/src/manager.tsx\n",
      "packages/features/themes/package.json": "{}",
    });
    expect(parseIndex(fs.readFileSync(path.join(root, "docs/INDEX.md"), "utf8"))).toEqual([
      { title: "Themes", doc: "docs/themes.md", useWhen: "Changing `packages/features/themes`" },
      { title: "Audit", doc: "docs/security.md", useWhen: "Audits" },
    ]);
    expect(packageDir(root, "packages/features/themes/src/manager.tsx")).toBe("packages/features/themes");
    const [result] = docsForPaths(root, ["packages/features/themes/src/manager.tsx"]);
    expect(result.docs).toEqual([
      { doc: "docs/editor.md", title: null, via: "path", lines: [1] },
      { doc: "docs/themes.md", title: "Themes", via: "index", lines: [] },
    ]);
  });
});

describe("JSON-RPC handler", () => {
  const tools = [
    { definition: { name: "echo", inputSchema: { type: "object" } }, run: (args: any) => ({ echoed: args.value }) },
    { definition: { name: "boom", inputSchema: { type: "object" } }, run: () => { throw new Error("broke"); } },
  ];
  const handle = createHandler({ tools, ctx: {}, serverInfo: { name: "t", version: "0" } });

  it("negotiates initialize versions", async () => {
    const asked = await handle(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }));
    expect(asked.result.protocolVersion).toBe("2025-06-18");
    const unknown = await handle(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2030-01-01" } }));
    expect(unknown.result.protocolVersion).toBe("2025-11-25");
  });

  it("returns results, tool errors and protocol errors", async () => {
    const ok = await handle(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "echo", arguments: { value: 2 } } }));
    expect(ok.result).toEqual({ content: [{ type: "text", text: JSON.stringify({ echoed: 2 }, null, 2) }], structuredContent: { echoed: 2 } });
    const boom = await handle(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "boom" } }));
    expect(boom.result).toEqual({ content: [{ type: "text", text: "broke" }], isError: true });
    const badArgs = await handle(JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "echo", arguments: [] } }));
    expect(badArgs.error.code).toBe(-32602);
    expect((await handle("{not json")).error).toEqual({ code: -32700, message: "Parse error" });
    expect((await handle(JSON.stringify({ jsonrpc: "1.0", id: 6, method: "ping" }))).error.code).toBe(-32600);
    expect((await handle(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "toString" }))).error.code).toBe(-32601);
    expect(await handle(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled" }))).toBeNull();
  });
});
