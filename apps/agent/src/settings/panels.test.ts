import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileAuthStore } from "../auth.js";
import { panelContext, testSetup } from "../testing.js";
import { createSettingsManager } from "./index.js";

async function setup() {
  const t = await testSetup([]);
  const manager = createSettingsManager({ config: t.config, auth: new FileAuthStore(t.config.paths.auth), env: {}, home: t.home, provider: () => t.setup.provider });
  const saved = async () => JSON.parse(await readFile(t.config.paths.settings, "utf8"));
  return { ...t, manager, saved, context: panelContext(t.root) };
}

describe("config panel", () => {
  it("saves switches, the compact threshold, the mode and folder trust", async () => {
    const s = await setup();
    const panel = await s.manager.panel("config", s.context);
    expect(panel.rows.map((row) => row.id)).toEqual(["mode", "auto-compact", "compact-at", "claude-instructions", "claude-hooks", "codex-hooks",
      "project-mcp", "all-project-mcp"]);
    expect(panel.rows.map((row) => row.enabled ?? row.choice?.value)).toEqual(["ask", true, "default", false, false, false, false, false]);
    await s.manager.toggle("config", "auto-compact", false, s.context);
    expect(await s.manager.choose("config", "compact-at", "80", s.context)).toEqual({ message: "Auto-compact starts at 80% of the context window" });
    expect(await s.manager.choose("config", "mode", "full-auto", s.context)).toEqual({ mode: "full-auto", message: "Permission mode: Full auto" });
    await s.manager.toggle("config", "project-mcp", true, s.context);
    expect(await s.saved()).toEqual({ autoCompact: false, autoCompactAt: 80, mode: "full-auto", trustedProjects: [s.root] });
    expect((await s.manager.panel("config", s.context)).rows.find((row) => row.id === "project-mcp")).toMatchObject({ enabled: true, detail: `Trusted: ${s.root}` });
    await s.manager.choose("config", "compact-at", "default", s.context);
    await s.manager.toggle("config", "all-project-mcp", true, s.context);
    expect(await s.manager.toggle("config", "project-mcp", false, s.context)).toEqual({ message: `Removed ${s.root}; this folder stays trusted through another setting` });
    expect(await s.saved()).toEqual({ autoCompact: false, mode: "full-auto", trustProjectMcp: true });
    await expect(s.manager.choose("config", "compact-at", "40", s.context)).rejects.toThrow("from 50 to 95");
    await expect(s.manager.choose("config", "mode", "yolo", s.context)).rejects.toThrow("Unknown mode yolo");
  });
});

describe("hooks panel", () => {
  it("lists hooks of the turned-on sources with stable IDs and saves the ones turned off", async () => {
    const s = await setup();
    await writeFile(s.config.paths.settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./guard.sh" }] }] } }));
    await s.config.reload();
    await mkdir(join(s.home, ".claude"), { recursive: true });
    await writeFile(join(s.home, ".claude", "settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] } }));
    const id = `oxbit|${s.config.paths.settings}|PreToolUse|Bash|./guard.sh`;
    const rows = (await s.manager.panel("hooks", s.context)).rows;
    expect(rows.map((row) => [row.id, row.label, row.detail, row.enabled])).toEqual([
      ["claude-hooks", "Claude hooks", expect.any(String), false], ["codex-hooks", "Codex hooks", expect.any(String), false],
      [id, "PreToolUse Bash", "./guard.sh · ~/settings.json", true]]);
    await s.manager.toggle("hooks", id, false, s.context);
    await s.manager.toggle("hooks", "claude-hooks", true, s.context);
    expect(await s.saved()).toMatchObject({ disabledHooks: [id], claudeHooks: true });
    const next = (await s.manager.panel("hooks", s.context)).rows;
    expect(next.slice(2).map((row) => [row.label, row.enabled])).toEqual([["PreToolUse Bash", false], ["Stop", true]]);
    await expect(s.manager.toggle("hooks", "nope", false, s.context)).rejects.toThrow("Unknown setting nope");
  });
});

describe("instructions panel", () => {
  it("shows missing global files without a checkbox, turns project files off and edits the global prompt", async () => {
    const s = await setup();
    const agents = join(s.root, "AGENTS.md");
    await writeFile(agents, "Use tabs.\nMore rules.");
    await s.config.saveSettings({ claudeInstructions: true });
    const rows = (await s.manager.panel("instructions", s.context)).rows;
    expect(rows.map((row) => [row.id, row.section, row.label, row.detail, row.enabled])).toEqual([
      ["prompt", "Global prompt", "Global prompt", "none", undefined],
      [s.config.paths.instructions, "Global files", "~/AGENTS.md", "not found", undefined],
      [join(s.home, ".claude", "CLAUDE.md"), "Global files", "~/.claude/CLAUDE.md", "not found", undefined],
      [agents, "Project files", agents, "Use tabs.", true]]);
    await s.manager.toggle("instructions", agents, false, s.context);
    expect(await s.manager.act("instructions", "prompt", "edit", ["Be brief.\nSecond line"], s.context)).toEqual({ message: "Saved the global prompt" });
    expect(await s.saved()).toMatchObject({ disabledInstructions: [agents], appendSystemPrompt: "Be brief.\nSecond line" });
    const next = (await s.manager.panel("instructions", s.context)).rows;
    expect([next[0].detail, next[0].actions?.[0].inputs?.[0].value, next[3].enabled]).toEqual(["Be brief.", "Be brief.\nSecond line", false]);
    expect(await s.manager.act("instructions", "prompt", "edit", ["  "], s.context)).toEqual({ message: "Cleared the global prompt" });
    expect(await s.saved()).not.toHaveProperty("appendSystemPrompt");
    await expect(s.manager.toggle("instructions", s.config.paths.instructions, false, s.context)).rejects.toThrow("Unknown setting");
  });
});
