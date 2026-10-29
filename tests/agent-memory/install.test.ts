import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error plain-node module without types
import { disable, enable } from "../../tools/agent-memory/lib/install.mjs";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function setup() {
  const root = mkdtempSync(join(tmpdir(), "agent-memory-install-"));
  roots.push(root);
  const repo = join(root, "repo");
  const home = join(root, "home");
  mkdirSync(repo);
  mkdirSync(home);
  return { repo, home, hookPath: join(repo, "tools/agent-memory/bin/hook.mjs") };
}

const read = (file: string) => JSON.parse(readFileSync(file, "utf8"));

describe("enable and disable", () => {
  it("writes Claude Code local settings and removes the file again", () => {
    const options = setup();
    const { file } = enable("claude", options);
    expect(file).toBe(join(options.repo, ".claude", "settings.local.json"));
    expect(Object.keys(read(file).hooks)).toEqual(["UserPromptSubmit", "PostToolUse", "SessionStart", "PreCompact"]);
    expect(read(file).hooks.SessionStart[0].matcher).toBe("compact|clear");
    expect(disable("claude", options).deleted).toBe(true);
    expect(existsSync(file)).toBe(false);
  });

  it("keeps other hooks and settings and does not duplicate on a second enable", () => {
    const options = setup();
    const file = join(options.home, ".codex", "hooks.json");
    mkdirSync(join(options.home, ".codex"));
    const other = { hooks: [{ type: "command", command: "other-hook" }] };
    writeFileSync(file, JSON.stringify({ hooks: { PostToolUse: [other] } }));
    enable("codex", options);
    enable("codex", options);
    expect(read(file).hooks.PostToolUse).toHaveLength(2);
    expect(read(file).hooks.PostToolUse[1].hooks[0].command).toContain(`--project "${options.repo}"`);
    disable("codex", options);
    expect(read(file)).toEqual({ hooks: { PostToolUse: [other] } });
  });

  it("writes Cursor's versioned hooks file with tool and compaction events only", () => {
    const options = setup();
    const { file } = enable("cursor", options);
    expect(read(file).version).toBe(1);
    expect(Object.keys(read(file).hooks)).toEqual(["postToolUse", "preCompact"]);
    disable("cursor", options);
    expect(existsSync(file)).toBe(false);
  });
});
