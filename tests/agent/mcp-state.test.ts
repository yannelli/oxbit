import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import * as fs from "node:fs";
// @ts-expect-error plain-node MCP modules without types
import { parsePorcelainZ, resolvePaths } from "../../scripts/agent/mcp/paths.mjs";
// @ts-expect-error plain-node MCP modules without types
import { scanRoot, unpushedWork } from "../../scripts/agent/mcp/unpushed.mjs";
// @ts-expect-error plain-node MCP modules without types
import { addEntry, listLedgers, parseLedger, updateEntry } from "../../scripts/agent/mcp/ledger.mjs";
// @ts-expect-error plain-node MCP modules without types
import { compareVersions, doctor } from "../../scripts/agent/mcp/doctor.mjs";
// @ts-expect-error plain-node MCP modules without types
import { staleWork } from "../../scripts/agent/mcp/stale.mjs";

const repo = path.resolve(import.meta.dirname, "../..");
const temps: string[] = [];
const GIT_ENV = { ...process.env, GIT_CONFIG_COUNT: "3", GIT_CONFIG_KEY_0: "commit.gpgsign", GIT_CONFIG_VALUE_0: "false", GIT_CONFIG_KEY_1: "user.name", GIT_CONFIG_VALUE_1: "t", GIT_CONFIG_KEY_2: "user.email", GIT_CONFIG_VALUE_2: "t@example.com" };

function temp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oxbit-mcp-state-"));
  temps.push(dir);
  return dir;
}

function git(dir: string, ...args: string[]) {
  return execFileSync("git", ["-C", dir, ...args], { env: GIT_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function commit(dir: string, file: string, text = file) {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
  git(dir, "add", file);
  git(dir, "commit", "-q", "-m", file);
}

function stubBin(stubs: Record<string, string>) {
  const bin = temp();
  for (const [name, body] of Object.entries(stubs)) fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
}

afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("changed paths", () => {
  it("combines commits against origin/main with the working tree", () => {
    const origin = temp();
    git(origin, "init", "-q", "-b", "main");
    commit(origin, "README.md");
    const clone = path.join(temp(), "clone");
    execFileSync("git", ["clone", "-q", origin, clone], { env: GIT_ENV });
    git(clone, "switch", "-q", "-c", "feature");
    commit(clone, "packages/a/src/index.ts");
    fs.writeFileSync(path.join(clone, "README.md"), "changed\n");
    fs.writeFileSync(path.join(clone, "new file.css"), "x\n");
    expect(resolvePaths(clone, GIT_ENV, undefined)).toEqual({
      base: "origin/main...HEAD + working tree",
      paths: ["README.md", "new file.css", "packages/a/src/index.ts"],
    });
    expect(resolvePaths(clone, GIT_ENV, ["./b.ts", path.join(clone, "c.ts"), "../outside"]).paths).toEqual(["b.ts", "c.ts"]);
  });

  it("explains a missing origin/main", () => {
    const dir = temp();
    git(dir, "init", "-q", "-b", "main");
    commit(dir, "a.txt");
    expect(() => resolvePaths(dir, GIT_ENV, undefined)).toThrow("origin/main not found");
  });

  it("parses renames in porcelain -z output", () => {
    expect(parsePorcelainZ("R  new.ts\0old.ts\0 M b.ts\0?? c.ts\0")).toEqual(["new.ts", "b.ts", "c.ts"]);
  });
});

describe("unpushed_work", () => {
  it("scans <id>/<name> and flat worktrees and flags dirty and unpushed ones", () => {
    const root = temp();
    const unpushed = path.join(root, "id1", "unpushed");
    const clean = path.join(root, "flat-clean");
    for (const dir of [unpushed, clean]) {
      fs.mkdirSync(dir, { recursive: true });
      git(dir, "init", "-q", "-b", "main");
      commit(dir, "a.txt");
    }
    const origin = temp();
    git(origin, "init", "-q", "--bare");
    git(clean, "remote", "add", "origin", origin);
    git(clean, "push", "-q", "-u", "origin", "main");
    expect(scanRoot(root).sort()).toEqual([clean, unpushed].sort());

    const result = unpushedWork({ repo: unpushed, env: { ...GIT_ENV, OXBIT_WORKTREE_ROOTS: root }, includeClean: true });
    expect(result.scanned).toBe(2);
    expect(result.atRisk).toEqual([expect.objectContaining({ path: unpushed, branch: "main", unpushed: 1, dirty: 0 })]);
    expect(result.clean).toEqual([expect.objectContaining({ path: clean, upstream: "origin/main", unpushed: 0 })]);
  });
});

describe("ledgers", () => {
  function copyLedgers() {
    const dir = temp();
    fs.cpSync(path.join(repo, "docs/agents/ledgers"), dir, { recursive: true });
    return dir;
  }

  it("lists the repo ledgers with unique IDs and no private material", () => {
    const ledgers = listLedgers(path.join(repo, "docs/agents/ledgers"));
    expect(ledgers.map((entry: any) => entry.ledger)).toEqual(["follow-ups", "open-questions", "device-checks", "account-actions", "flaky-tests"]);
    const ids = ledgers.flatMap((entry: any) => entry.rows.map((row: any) => row.id));
    expect(new Set(ids).size).toBe(ids.length);
    const counts = Object.fromEntries(ledgers.map((entry: any) => [entry.ledger, entry.rows.length]));
    expect(counts).toMatchObject({ "open-questions": 0, "account-actions": 0 });
    for (const name of ["follow-ups", "device-checks", "flaky-tests"]) expect(counts[name]).toBeGreaterThan(0);
    for (const file of fs.readdirSync(path.join(repo, "docs/agents/ledgers"))) {
      const text = fs.readFileSync(path.join(repo, "docs/agents/ledgers", file), "utf8");
      expect(text.split("\n").length).toBeLessThan(300);
      expect(text).not.toMatch(/\.p8\b|AuthKey_|private_keys|\b[A-Z0-9]{10}\b|\bP\d{3}\b/);
    }
  });

  it("keeps personal ledgers in the local directory and merges both on list", () => {
    const dirs = { repo: copyLedgers(), local: path.join(temp(), "local") };
    const question = addEntry(dirs, { ledger: "open-questions", item: "Which first", source: "PR #1", date: "2026-11-01" });
    expect(question).toMatchObject({ location: "local", row: { id: "Q-001" } });
    expect(fs.readFileSync(path.join(dirs.local, "open-questions.md"), "utf8")).toContain("| Q-001 | open | Which first | PR #1 | 2026-11-01 |");
    expect(fs.existsSync(path.join(dirs.repo, "open-questions.md"))).toBe(false);
    const flake = addEntry(dirs, { ledger: "flaky-tests", item: "local flake", source: "run 7", local: true });
    expect(flake).toMatchObject({ location: "local", row: { id: "T-001" } });
    const rows = listLedgers(dirs, { ledger: "flaky-tests" })[0].rows;
    expect(rows.map((row: any) => `${row.location}:${row.id}`)).toEqual(["repo:T-001", "repo:T-002", "local:T-001"]);
    updateEntry(dirs, { ledger: "open-questions", id: "Q-001", status: "done" });
    expect(listLedgers(dirs, { ledger: "open-questions", status: "done" })[0].rows).toHaveLength(1);
  });

  it("adds, escapes, updates and filters rows", () => {
    const dir = copyLedgers();
    const added = addEntry(dir, { ledger: "flaky-tests", item: "a | b\nc", source: "run 42", date: "2026-11-01" });
    expect(added.row.id).toBe("T-003");
    const text = fs.readFileSync(path.join(dir, "flaky-tests.md"), "utf8");
    expect(text).toContain("| T-003 | open | a \\| b c | run 42 | 2026-11-01 |");
    expect(text).toContain("Last updated: 2026-11-01.");
    expect(parseLedger(text).at(-1).item).toBe("a | b c");
    updateEntry(dir, { ledger: "flaky-tests", id: "T-001", status: "done", date: "2026-11-02" });
    expect(listLedgers(dir, { ledger: "flaky-tests", status: "done" })[0].rows.map((row: any) => row.id)).toEqual(["T-001"]);
    expect(() => updateEntry(dir, { ledger: "flaky-tests", id: "T-099", status: "done" })).toThrow("No row T-099 in the repo flaky-tests ledger");
    expect(() => addEntry(dir, { ledger: "flaky-tests", item: "x", source: "y", status: "maybe" })).toThrow('Unknown status "maybe"');
    expect(() => addEntry(dir, { ledger: "flaky-tests", item: "x", source: " " })).toThrow("source is required");
  });

  it("refuses a row past 300 lines", () => {
    const dir = copyLedgers();
    const file = path.join(dir, "flaky-tests.md");
    const rows = Array.from({ length: 300 - fs.readFileSync(file, "utf8").split("\n").length }, (_, i) => `| T-${String(i + 3).padStart(3, "0")} | done | x | y | 2026-10-21 |`);
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/\n$/, `\n${rows.join("\n")}\n`));
    expect(() => addEntry(dir, { ledger: "flaky-tests", item: "x", source: "y" })).toThrow("would pass 300 lines");
  });
});

describe("doctor", () => {
  it("compares versions", () => {
    expect(compareVersions("24.20.0", "24.21.0")).toEqual({ expected: "24.20.0", actual: "24.21.0", match: false, majorMatch: true });
    expect(compareVersions("24.20.0", null)).toMatchObject({ match: false, majorMatch: false });
  });

  it("reports a Background session and version drift", () => {
    const root = temp();
    fs.writeFileSync(path.join(root, ".node-version"), "24.20.0\n");
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ packageManager: "bun@1.4.2" }));
    const env = stubBin({ launchctl: "echo Background", bun: "echo 1.4.3", node: "echo v24.20.0" });
    const report = doctor({ root, env, platform: "darwin" });
    expect(report.session).toMatchObject({ manager: "Background", background: true });
    expect(report.session.note).toContain("open -a Terminal /tmp/task.command");
    expect(report.node).toMatchObject({ expected: "24.20.0", actual: "24.20.0", match: true });
    expect(report.bun).toMatchObject({ expected: "1.4.2", actual: "1.4.3", match: false });
    expect(report.problems).toEqual(["Background security session", "bun 1.4.3 differs from packageManager bun@1.4.2"]);
    expect(doctor({ root, env: stubBin({ launchctl: "echo Aqua", bun: "echo 1.4.2", node: "echo v24.20.0" }), platform: "darwin" }).problems).toEqual([]);
    expect(doctor({ root, env, platform: "linux" }).session.manager).toBeNull();
  });
});

describe("stale_work", () => {
  it("sorts draft PRs by commits behind main", () => {
    const env = stubBin({
      gh: [
        'if [ "$1" = pr ]; then echo \'[{"number":1,"headRefName":"a"},{"number":2,"headRefName":"b"}]\'; exit 0; fi',
        'case "$2" in *...a) printf "3\\t1\\n" ;; *) printf "47\\t2\\n" ;; esac',
      ].join("\n"),
    });
    const result = staleWork({ root: temp(), env });
    expect(result.drafts.map((pr: any) => [pr.number, pr.behindMain, pr.aheadOfMain])).toEqual([[2, 47, 2], [1, 3, 1]]);
  });

  it("fails soft when gh fails", () => {
    const env = stubBin({ gh: 'echo "gh: not logged in" >&2; exit 4' });
    expect(staleWork({ root: temp(), env })).toEqual({ available: false, error: "gh: not logged in", drafts: [] });
  });
});
