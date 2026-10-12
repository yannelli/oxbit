import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chatText, chatTool } from "@oxbit/agent-core/test-models";
import { MemoryConnection } from "./connection.js";
import { testSetup } from "./testing.js";

const system = (request: { body?: unknown }) => JSON.stringify((request.body as { messages?: { role: string; content: string }[] }).messages?.find((message) => message.role === "system")?.content ?? "");

describe("core extensions in the Node host", () => {
  it("adds AGENTS.md and skills to the system prompt and runs a settings.json hook that blocks bash", async () => {
    const t = await testSetup([chatTool("call_1", "bash", { command: "rm -rf build" }), chatText("Done")]);
    await writeFile(join(t.root, "AGENTS.md"), "Use tabs in this repo.");
    await mkdir(join(t.home, ".claude", "skills", "release"), { recursive: true });
    await writeFile(join(t.home, ".claude", "skills", "release", "SKILL.md"), "---\nname: release\ndescription: Cut a release\n---\nRun the release script.");
    await writeFile(t.config.paths.settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash",
      hooks: [{ type: "command", command: "cat > \"$OXBIT_PROJECT_DIR/hook-input.json\"; echo 'rm is blocked' >&2; exit 2" }] }] } }));
    const updates: { sessionUpdate: string; availableCommands?: { name: string }[] }[] = [];
    const connection = await MemoryConnection.open(t.factory);
    connection.onUpdate((_id, update) => updates.push(update as never));
    const { sessionId } = await connection.newSession({ cwd: t.root });
    expect(await connection.prompt(sessionId, "Clean the build")).toEqual({ stopReason: "end_turn" });

    const posts = t.fake.requests.filter((request) => request.method === "POST");
    expect(system(posts[0])).toContain("Use tabs in this repo.");
    expect(system(posts[0])).toContain("<name>release</name>");
    const input = JSON.parse(await readFile(join(t.root, "hook-input.json"), "utf8"));
    expect(input).toMatchObject({ hook_event_name: "PreToolUse", tool_name: "bash", tool_input: { command: "rm -rf build" }, permission_mode: "default" });
    expect(JSON.stringify(posts[1].body)).toContain("rm is blocked");
    const names = updates.filter((update) => update.sessionUpdate === "available_commands_update").at(-1)?.availableCommands?.map((command) => command.name);
    expect(names).toEqual(expect.arrayContaining(["undo", "redo", "compact", "goal", "loop", "skills", "release"]));
    connection.close();
  });
});
