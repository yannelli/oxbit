import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error plain-node hook module without types
import { checksVerdict, mergeRequest } from "../../scripts/agent/hooks/merge.mjs";
import { runHook, tempDir } from "./hooks-helpers";

const PASS = '[{"name":"check","state":"SUCCESS","bucket":"pass"},{"name":"docs","state":"SKIPPED","bucket":"skipping"}]';
const FAIL = '[{"name":"check","state":"FAILURE","bucket":"fail"},{"name":"build","state":"SUCCESS","bucket":"pass"}]';
const PENDING = '[{"name":"check","state":"IN_PROGRESS","bucket":"pending"}]';

const STUB = `#!/bin/sh
echo "$*" >> "$GH_STUB_LOG"
case "$GH_STUB_MODE" in
  pass) echo '${PASS}' ;;
  fail) echo '${FAIL}' ;;
  pending) echo '${PENDING}'; exit 8 ;;
  error) echo 'HTTP 502: Bad Gateway' >&2; exit 1 ;;
  empty) echo '[]' ;;
  slow) exec sleep 8 ;;
  required) case "$*" in *--required*) echo '${PASS}' ;; *) echo '${FAIL}' ;; esac ;;
  norequired) case "$*" in *--required*) echo "no required checks reported on the 'x' branch" >&2; exit 1 ;; *) echo '${FAIL}' ;; esac ;;
esac
`;

let stubDir = "";
let runs = 0;

function merge(mode: string, command = "gh pr merge 41 --squash", tool = "claude") {
  const log = path.join(stubDir, `${mode}-${tool}-${(runs += 1)}.log`);
  const env = { ...process.env, PATH: `${stubDir}:${process.env.PATH}`, GH_STUB_MODE: mode, GH_STUB_LOG: log };
  const input = tool === "cursor" ? { command, cwd: stubDir } : { tool_name: "Bash", tool_input: { command }, cwd: stubDir };
  const result = runHook(tool, "pre-shell", input, env);
  const calls = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [];
  return { ...result, calls };
}

function denied(stdout: string): boolean {
  return stdout.includes('"permissionDecision":"deny"') || stdout.includes('"permission":"deny"');
}

beforeAll(() => {
  stubDir = tempDir("gh-stub-");
  fs.writeFileSync(path.join(stubDir, "gh"), STUB, { mode: 0o755 });
});

describe("gh pr merge gate with a stub gh", () => {
  it("allows when every check passes or is skipped", () => {
    const result = merge("pass");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.calls).toEqual(["pr checks 41 --json name,state,bucket --required"]);
  });
  it("blocks when a check fails and names it", () => {
    const result = merge("fail");
    expect(denied(result.stdout)).toBe(true);
    expect(result.stdout).toContain("check (fail)");
  });
  it("blocks while checks are pending even though gh exits 8", () => {
    const result = merge("pending");
    expect(denied(result.stdout)).toBe(true);
    expect(result.stdout).toContain("check (pending)");
  });
  it("allows and explains on stderr when gh errors", () => {
    const result = merge("error");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("HTTP 502: Bad Gateway");
  });
  it("allows and explains on stderr when gh times out", () => {
    const result = merge("slow");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("ETIMEDOUT");
  });
  it("allows with a note when the PR has no checks", () => {
    const result = merge("empty");
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("no checks");
  });
  it("uses only the required checks when the repo has some", () => {
    const result = merge("required");
    expect(result.stdout).toBe("");
    expect(result.calls).toHaveLength(1);
  });
  it("treats every check as required when the repo has none", () => {
    const result = merge("norequired", "gh pr merge 41 -R yannelli/oxbit");
    expect(denied(result.stdout)).toBe(true);
    expect(result.calls).toEqual([
      "pr checks 41 -R yannelli/oxbit --json name,state,bucket --required",
      "pr checks 41 -R yannelli/oxbit --json name,state,bucket",
    ]);
  });
  it("checks merges inside compound commands", () => {
    expect(denied(merge("fail", "git push && gh pr merge 41 --squash --delete-branch").stdout)).toBe(true);
  });
  it("uses the Cursor deny shape and allow shape", () => {
    expect(JSON.parse(merge("fail", undefined, "cursor").stdout)).toMatchObject({ permission: "deny" });
    expect(JSON.parse(merge("pass", undefined, "cursor").stdout)).toEqual({ permission: "ask" });
  });
  it("does not call gh for other gh commands", () => {
    const result = merge("fail", "gh pr view 41 && gh pr checks 41");
    expect(result.stdout).toBe("");
    expect(result.calls).toEqual([]);
  });
});

describe("merge command parsing", () => {
  it("reads the PR argument and repo flag", () => {
    expect(mergeRequest("gh pr merge 12 --squash -R o/r")).toEqual({ pr: "12", repo: "o/r" });
    expect(mergeRequest("gh pr merge --repo=o/r --subject 'x y' feat/a")).toEqual({ pr: "feat/a", repo: "o/r" });
    expect(mergeRequest("gh pr merge --auto")).toEqual({ pr: null, repo: null });
    expect(mergeRequest("gh pr view 12")).toBeNull();
  });
  it("lists failing checks and caps the list", () => {
    const checks = Array.from({ length: 10 }, (_, index) => ({ name: `c${index}`, bucket: "fail" }));
    expect(checksVerdict(checks)).toContain("and 2 more");
    expect(checksVerdict([{ name: "a", bucket: "pass" }])).toBeNull();
    expect(checksVerdict([{ name: "a", bucket: "cancel" }])).toContain("a (cancel)");
  });
});
