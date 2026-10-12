import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SessionRecord } from "@oxbit/agent-core";
import { cwdHash } from "./config.js";
import { JsonlSessionStore } from "./sessions.js";
import { tempDir } from "./testing.js";

const record = (id: string, cwd: string, updatedAt: string): SessionRecord => ({
  id, cwd, title: `Session ${id}`, model: "model-a", updatedAt, meta: { mode: "ask", snapshots: [{ id: "a".repeat(40), label: "Write", turn: 2 }] },
  turns: [{ role: "user", text: "Hi\nthere" }, { role: "assistant", text: "Hello", calls: [{ id: "c1", name: "read_file", arguments: "{\"path\":\"a\"}" }] },
    { role: "tool", results: [{ id: "c1", name: "read_file", output: "A" }] }],
});

describe("JsonlSessionStore", () => {
  it("round-trips a session as JSONL under the cwd hash", async () => {
    const dir = await tempDir("oxa-sessions-");
    const store = new JsonlSessionStore(dir);
    const saved = record("s1", "/work/app", "2026-10-11T10:00:00.000Z");
    await store.save(saved);
    const file = join(dir, cwdHash("/work/app"), "s1.jsonl");
    const lines = (await readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.map((line) => line.type)).toEqual(["session", "turn", "turn", "turn"]);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await new JsonlSessionStore(dir).load("s1")).toEqual(saved);
  });

  it("lists sessions for one cwd, newest first, without turns", async () => {
    const store = new JsonlSessionStore(await tempDir("oxa-sessions-"));
    await store.save(record("old", "/work/app", "2026-10-10T10:00:00.000Z"));
    await store.save(record("new", "/work/app", "2026-10-11T10:00:00.000Z"));
    await store.save(record("other", "/work/other", "2026-10-12T10:00:00.000Z"));
    const list = await store.list("/work/app");
    expect(list.map((item) => item.id)).toEqual(["new", "old"]);
    expect(list[0]).not.toHaveProperty("turns");
    expect((await store.latest("/work/app"))?.id).toBe("new");
    expect(await store.list("/nowhere")).toEqual([]);
  });

  it("moves the file when a session's cwd changes and rejects unsafe IDs", async () => {
    const dir = await tempDir("oxa-sessions-");
    const store = new JsonlSessionStore(dir);
    await store.save(record("s1", "/work/a", "2026-10-11T10:00:00.000Z"));
    await store.save(record("s1", "/work/b", "2026-10-11T11:00:00.000Z"));
    expect(await readdir(join(dir, cwdHash("/work/a")))).toEqual([]);
    expect((await store.load("s1"))?.cwd).toBe("/work/b");
    expect(await store.load("../s1")).toBeUndefined();
    await expect(store.save(record("../x", "/work/a", ""))).rejects.toThrow("Invalid session ID");
  });
});
