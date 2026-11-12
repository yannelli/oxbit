import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chatText, type Reply } from "@oxbit/agent-core/test-models";
import { MemoryConnection } from "./connection.js";
import { agentFactory } from "./host.js";
import { testSetup } from "./testing.js";

type Update = { sessionUpdate: string; content?: { text?: string } };

/** A Node host whose settings.json has `hooks`, run through /bin/sh. */
async function withHooks(replies: Reply[], hooks: Record<string, unknown>) {
  const t = await testSetup(replies);
  await writeFile(t.config.paths.settings, JSON.stringify({ hooks }));
  await t.config.reload();
  const logs: string[] = [];
  const updates: Update[] = [];
  const connection = await MemoryConnection.open(agentFactory({ ...t.setup, log: (text) => logs.push(text) }));
  connection.onUpdate((_id, update) => updates.push(update as Update));
  const { sessionId } = await connection.newSession({ cwd: t.root });
  const posts = () => t.fake.requests.filter((request) => request.method === "POST");
  const text = (kind: string) => updates.filter((update) => update.sessionUpdate === kind).map((update) => update.content?.text ?? "");
  return { ...t, connection, sessionId, logs, posts, text };
}
const command = (line: string, extra: Record<string, unknown> = {}) => [{ hooks: [{ type: "command", command: line, ...extra }] }];

describe("command hooks in the Node host", () => {
  it("keeps the turn going when a hook crashes, times out or prints invalid JSON", async () => {
    const t = await withHooks([chatText("Answer"), chatText("Again")], {
      UserPromptSubmit: [...command("echo boom >&2; exit 1"), ...command("sleep 5", { timeout: 0.3 })],
      Stop: command("echo '{\"decision\": '"),
    });
    expect(await t.connection.prompt(t.sessionId, "Hi")).toEqual({ stopReason: "end_turn" });
    expect(t.text("agent_message_chunk")).toEqual(["Answer"]);
    expect(t.logs).toEqual(expect.arrayContaining([expect.stringContaining('UserPromptSubmit hook "echo boom >&2; exit 1" exited with 1: boom'),
      expect.stringContaining('UserPromptSubmit hook "sleep 5" timed out after 0.3 s')]));
    expect(await t.connection.prompt(t.sessionId, "Again")).toEqual({ stopReason: "end_turn" });
    expect(t.posts()).toHaveLength(2);
    await t.connection.close();
  });
  it("ends the turn with a UserPromptSubmit block's reason as a message and sends nothing to the model", async () => {
    const t = await withHooks([chatText("Unused")], { UserPromptSubmit: command("echo 'Prompts must not contain secrets' >&2; exit 2") });
    expect(await t.connection.prompt(t.sessionId, "My key is sk-1")).toEqual({ stopReason: "end_turn" });
    expect(t.text("agent_message_chunk").join("").trim()).toBe("Prompts must not contain secrets");
    expect(t.posts()).toHaveLength(0);
    await t.connection.close();
  });
  it("leaves a project's hook files off until settings.json trusts the folder", async () => {
    const t = await withHooks([chatText("One"), chatText("Two")], {});
    const marker = join(t.home, "project-hook-ran");
    await mkdir(join(t.root, ".oxbit"));
    await writeFile(join(t.root, ".oxbit", "settings.json"), JSON.stringify({ disableAllHooks: false,
      hooks: { UserPromptSubmit: command(`echo ran >> '${marker}'`) } }));
    expect(await t.connection.prompt(t.sessionId, "Hi")).toEqual({ stopReason: "end_turn" });
    await expect(readFile(marker, "utf8")).rejects.toThrow();
    expect(t.logs).toEqual(expect.arrayContaining([expect.stringContaining(`Hooks in ${join(t.root, ".oxbit", "settings.json")} are off`)]));
    await writeFile(t.config.paths.settings, JSON.stringify({ trustedProjects: [t.root] }));
    expect(await t.connection.prompt(t.sessionId, "Again")).toEqual({ stopReason: "end_turn" });
    expect(await readFile(marker, "utf8")).toBe("ran\n");
    await t.connection.close();
  });
  it("keeps the user's hooks on when an untrusted project file sets disableAllHooks", async () => {
    const t = await withHooks([chatText("Unused")], { UserPromptSubmit: command("echo 'Blocked by the user hook' >&2; exit 2") });
    await mkdir(join(t.root, ".oxbit"));
    await writeFile(join(t.root, ".oxbit", "settings.json"), JSON.stringify({ disableAllHooks: true }));
    expect(await t.connection.prompt(t.sessionId, "Hi")).toEqual({ stopReason: "end_turn" });
    expect(t.text("agent_message_chunk").join("").trim()).toBe("Blocked by the user hook");
    expect(t.posts()).toHaveLength(0);
    await t.connection.close();
  });
  it("continues the turn with a Stop block's reason, then ends when the hook allows it", async () => {
    const t = await withHooks([chatText("Done"), chatText("Tests pass")], {
      Stop: command('[ -f "$OXBIT_PROJECT_DIR/stopped" ] && exit 0; touch "$OXBIT_PROJECT_DIR/stopped"; echo "Run the tests first" >&2; exit 2'),
    });
    expect(await t.connection.prompt(t.sessionId, "Fix it")).toEqual({ stopReason: "end_turn" });
    expect(t.text("agent_message_chunk")).toEqual(["Done", "Tests pass"]);
    expect(t.text("user_message_chunk")).toEqual(["Run the tests first"]);
    expect(JSON.stringify(t.posts()[1].body)).toContain("Run the tests first");
    await t.connection.close();
  });
});
