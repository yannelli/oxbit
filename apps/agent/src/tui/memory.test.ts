import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { chatText, chatTool } from "@oxbit/agent-core/test-models";
import { MemoryConnection } from "../connection.js";
import { panelContext, testSetup } from "../testing.js";
import type { SettingsManager } from "./connection.js";
import { fileHistory, memoryTuiConnection } from "./memory.js";

describe("memoryTuiConnection", () => {
  it("applies the start mode, lists files for @ mentions and answers permission prompts", async () => {
    const t = await testSetup([chatTool("call_1", "write_file", { path: "notes.md", content: "hi" }), chatText("Done")]);
    await mkdir(join(t.root, "src"), { recursive: true });
    await writeFile(join(t.root, "src", "login.ts"), "");
    await writeFile(join(t.root, ".gitignore"), "build/\n");
    await mkdir(join(t.root, "build"), { recursive: true });
    await writeFile(join(t.root, "build", "login.js"), "");
    const memory = await MemoryConnection.open(t.factory);
    const connection = memoryTuiConnection(memory, { provider: "Ollama", mode: "accept-edits" });
    expect(connection.info()).toEqual({ provider: "Ollama", usingChatGPTPlan: undefined });

    const state = await connection.newSession(t.root);
    expect(state.modes?.currentModeId).toBe("accept-edits");
    expect(await connection.listFiles!("login", t.root)).toEqual(["src/login.ts"]);

    await connection.setMode(state.sessionId, "ask");
    const asked: string[] = [];
    connection.onPermission(async (request) => {
      asked.push(request.toolCall.toolCallId);
      return { outcome: { outcome: "selected", optionId: request.options.find((option) => option.kind === "allow_once")!.optionId } };
    });
    expect(await connection.prompt(state.sessionId, [{ type: "text", text: "Write notes" }])).toEqual({ stopReason: "end_turn" });
    expect(asked).toEqual(["call_1"]);
    expect(await readFile(join(t.root, "notes.md"), "utf8")).toBe("hi");
    expect((await connection.listSessions!(t.root)).map((session) => session.sessionId)).toEqual([state.sessionId]);
    await memory.close();
  });
});

describe("memoryTuiConnection replace", () => {
  it("keeps listeners and the permission handler from before a rebuild and uses the mode chosen in /config for new sessions", async () => {
    const t = await testSetup([chatTool("call_1", "write_file", { path: "notes.md", content: "hi" }), chatText("Done")]);
    const first = await MemoryConnection.open(t.factory);
    const settings = { panel: vi.fn(), toggle: vi.fn(), act: vi.fn(), choose: vi.fn(async () => ({ mode: "full-auto", message: "Permission mode: Full auto" })) };
    const connection = memoryTuiConnection(first, { provider: "Ollama", mode: "accept-edits", settings: settings as unknown as SettingsManager });
    const updates: string[] = [];
    connection.onUpdate((_id, update) => updates.push(update.sessionUpdate));
    const asked: string[] = [];
    connection.onPermission(async (request) => {
      asked.push(request.toolCall.toolCallId);
      return { outcome: { outcome: "selected", optionId: request.options.find((option) => option.kind === "allow_once")!.optionId } };
    });

    const second = await MemoryConnection.open(t.factory);
    const closed = vi.spyOn(first, "close");
    await connection.replace(second, { provider: "Anthropic", usingChatGPTPlan: false });
    expect(closed).toHaveBeenCalled();
    expect(connection.connection).toBe(second);
    expect(connection.info()).toEqual({ provider: "Anthropic", usingChatGPTPlan: false });
    const state = await connection.newSession(t.root);
    expect(state.modes?.currentModeId).toBe("accept-edits");
    await connection.setMode(state.sessionId, "ask");
    expect(await connection.prompt(state.sessionId, [{ type: "text", text: "Write notes" }])).toEqual({ stopReason: "end_turn" });
    expect(asked).toEqual(["call_1"]);
    expect(updates).toContain("agent_message_chunk");

    expect(await connection.settings!.choose("config", "mode", "full-auto", panelContext(t.root))).toMatchObject({ mode: "full-auto" });
    expect((await connection.newSession(t.root)).modes?.currentModeId).toBe("full-auto");
    await second.close();
  });
});

describe("fileHistory", () => {
  it("saves prompts as JSON lines and skips lines it cannot read", async () => {
    const t = await testSetup([]);
    const path = join(t.home, "history.jsonl");
    const history = fileHistory(path);
    expect(history.load()).toEqual([]);
    history.save("first\nline");
    await writeFile(path, `${await readFile(path, "utf8")}not json\n`);
    history.save("second");
    expect(history.load()).toEqual(["first\nline", "second"]);
  });
});
