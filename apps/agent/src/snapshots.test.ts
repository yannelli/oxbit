import { execFileSync } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chatText, chatTool } from "@oxbit/agent-core/test-models";
import { MemoryConnection } from "./connection.js";
import { JsonlSessionStore } from "./sessions.js";
import { GitSnapshotStore } from "./snapshots.js";
import { tempDir, testSetup } from "./testing.js";

async function repo() {
  const root = await tempDir("oxa-repo-");
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  await writeFile(join(root, "a.txt"), "one");
  await writeFile(join(root, ".gitignore"), "ignored.txt\n");
  await writeFile(join(root, "ignored.txt"), "keep");
  return root;
}
const exists = (path: string) => access(path).then(() => true, () => false);

describe("GitSnapshotStore", () => {
  it("restores changed files, removes new files and leaves ignored files alone", async () => {
    const root = await repo();
    const store = new GitSnapshotStore(root, join(await tempDir("oxa-snap-"), "git"));
    const id = await store.capture("Before");
    expect(id).toMatch(/^[0-9a-f]{40}$/);
    await writeFile(join(root, "a.txt"), "two");
    await writeFile(join(root, "b.txt"), "new");
    await writeFile(join(root, "ignored.txt"), "changed");
    await store.restore(id!);
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("one");
    expect(await exists(join(root, "b.txt"))).toBe(false);
    expect(await readFile(join(root, "ignored.txt"), "utf8")).toBe("changed");
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" })).toContain("a.txt");
  });

  it("returns no snapshot when git is missing", async () => {
    const root = await repo();
    const path = process.env.PATH;
    process.env.PATH = "/nonexistent";
    try {
      const logs: string[] = [];
      expect(await new GitSnapshotStore(root, join(root, "..", "snap-missing"), (text) => logs.push(text)).capture("x")).toBeUndefined();
      expect(logs[0]).toContain("Snapshots are off");
    } finally {
      process.env.PATH = path;
    }
  });
});

describe("/undo and /redo", () => {
  it("restores the file and the conversation, then reapplies both", async () => {
    const root = await repo();
    const t = await testSetup([chatTool("call_1", "write_file", { path: "a.txt", content: "two" }), chatText("Changed it")], { root });
    const connection = await MemoryConnection.open(t.factory);
    const { sessionId } = await connection.newSession({ cwd: root });
    await connection.setMode(sessionId, "accept-edits");
    await connection.prompt(sessionId, "Change a.txt");
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("two");
    const store = new JsonlSessionStore(t.config.paths.sessions);
    expect((await store.load(sessionId))?.meta.snapshots).toEqual([expect.objectContaining({ label: "Write a.txt", turn: 2 })]);

    const notes: string[] = [];
    connection.onUpdate((_id, update) => update.sessionUpdate === "agent_message_chunk" && notes.push(update.content.text));
    expect(await connection.prompt(sessionId, "/undo")).toEqual({ stopReason: "end_turn" });
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("one");
    const undone = await store.load(sessionId);
    expect(undone?.turns).toEqual([]);
    expect(undone?.meta.snapshots).toEqual([]);
    expect(notes[0]).toContain("Restored files to before \"Write a.txt\"");

    await connection.prompt(sessionId, "/redo");
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("two");
    const redone = await store.load(sessionId);
    expect(redone?.turns.map((turn) => turn.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(redone?.meta.redo).toEqual([]);
    await connection.prompt(sessionId, "/redo");
    expect(notes.at(-1)).toBe("Nothing to redo.");
    await connection.close();
  });
});
