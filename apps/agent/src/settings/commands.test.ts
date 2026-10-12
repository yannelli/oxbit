import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chatText } from "@oxbit/agent-core/test-models";
import { MemoryConnection } from "../connection.js";
import { echoServer, testSetup } from "../testing.js";

const system = (body: unknown) => JSON.stringify((body as { messages: { role: string; content: unknown }[] }).messages.find((message) => message.role === "system")?.content ?? "");

describe("settings commands over ACP", () => {
  it("lists the commands, changes settings, manages MCP servers and hides a disabled skill from the next turn", async () => {
    const script = await echoServer();
    const t = await testSetup([chatText("one"), chatText("two")]);
    await mkdir(join(t.home, ".claude", "skills", "release"), { recursive: true });
    await writeFile(join(t.home, ".claude", "skills", "release", "SKILL.md"), "---\nname: release\ndescription: Cut a release\n---\nSteps");
    const connection = await MemoryConnection.open(t.factory);
    const updates: any[] = [];
    connection.onUpdate((_id, update) => updates.push(update));
    const session = await connection.newSession({ cwd: t.root });
    const run = async (text: string) => {
      updates.length = 0;
      expect(await connection.prompt(session.sessionId, text)).toEqual({ stopReason: "end_turn" });
      return updates.filter((update) => update.sessionUpdate === "agent_message_chunk").map((update) => update.content.text).join("");
    };
    const settings = async () => JSON.parse(await readFile(t.config.paths.settings, "utf8"));

    const listing = await run("/config");
    expect(listing).toContain("## Config\n\n**Permissions**\n1. Permission mode `mode`: ask (ask, accept-edits, full-auto)");
    expect(listing).toContain("2. [x] Auto-compact `auto-compact`");
    expect(listing).toContain("**Usage**\n- `/config <setting> <value>`");
    const names = updates.concat().reverse().find((update) => update.sessionUpdate === "available_commands_update")?.availableCommands
      .map((command: { name: string }) => command.name) ?? [];
    expect(names).toEqual(expect.arrayContaining(["config", "skills", "hooks", "mcp", "instructions", "providers", "release"]));
    expect(names.filter((name: string) => name === "skills" || name === "mcp")).toEqual(["skills", "mcp"]);

    expect(await run("/config auto-compact off")).toBe("Auto-compact is off");
    expect(await run("/config compact-at 80%")).toBe("Auto-compact starts at 80% of the context window");
    expect(await run("/config mode full-auto")).toBe("Permission mode: Full auto");
    expect(updates).toContainEqual({ sessionUpdate: "current_mode_update", currentModeId: "full-auto" });
    expect(await run("/config compact-at 20")).toBe("Compact at takes default or a percent from 50 to 95");
    expect(await settings()).toEqual({ autoCompact: false, autoCompactAt: 80, mode: "full-auto" });
    const options = await connection.setConfigOption(session.sessionId, "compact-at", "70");
    expect(options.configOptions.find((option) => option.id === "compact-at")).toMatchObject({ currentValue: "70" });
    expect(options.configOptions.find((option) => option.id === "auto-compact")).toMatchObject({ currentValue: "off" });
    expect((await settings()).autoCompactAt).toBe(70);

    expect(await run(`/mcp add echo "${process.execPath}" "${script}"`)).toBe("Added echo; it connects on the next turn");
    const mcp = await run("/mcp");
    expect(mcp).toContain("MCP servers (1):\n- echo (global, stdio, 2025-06-18): connected, 1 tools");
    expect(mcp).toContain("1. [x] echo · stdio");
    expect(await run("/mcp reload")).toBe("MCP servers (1):\n- echo (global, stdio, 2025-06-18): connected, 1 tools");

    await run("Ship it");
    const posts = () => t.fake.requests.filter((request) => request.method === "POST");
    expect(system(posts()[0].body)).toContain("<name>release</name>");
    expect(await run("/skills disable release")).toBe("release is off");
    expect(await run("/instructions prompt Be brief.")).toBe("Saved the global prompt");
    await run("Ship it again");
    expect(system(posts()[1].body)).not.toContain("<name>release</name>");
    expect(system(posts()[1].body)).toContain("Be brief.");
    expect(JSON.stringify(posts()[1].body)).toContain("mcp__echo__echo");

    expect(await run("/hooks")).toContain("No command hooks in the loaded files");
    expect(await run("/providers")).toContain("API keys: run `oxbit-agent login --provider <id>` in a terminal");
    expect(await run("/providers use anthropic")).toBe("Using Anthropic. It applies after the agent restarts.");
    expect(await run("/providers use nope")).toBe("No nope in Providers. Run /providers to list them.");
    expect(await run("/skills frobnicate")).toContain("Unknown /skills command. Usage:");
    expect(await settings()).toMatchObject({ provider: "anthropic", disabledSkills: ["release"], appendSystemPrompt: "Be brief." });
    await connection.close();
  });
});
