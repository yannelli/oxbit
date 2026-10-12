import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chatText, chatTool } from "@oxbit/agent-core/test-models";
import { MemoryConnection } from "../connection.js";
import { testSetup } from "../testing.js";
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
