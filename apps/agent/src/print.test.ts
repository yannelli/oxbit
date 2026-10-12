import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chatText, chatTool, hanging } from "@oxbit/agent-core/test-models";
import { MemoryConnection } from "./connection.js";
import { runPrint } from "./print.js";
import { sink, testSetup } from "./testing.js";

async function print(replies: Parameters<typeof testSetup>[0], options: Partial<Parameters<typeof runPrint>[0]> = {}, existing?: Awaited<ReturnType<typeof testSetup>>) {
  const t = existing ?? await testSetup(replies);
  const connection = await MemoryConnection.open(t.factory);
  const stdout = sink();
  const stderr = sink();
  const code = await runPrint({ connection, prompt: "Hi", cwd: t.root, stdout, stderr, ...options });
  await connection.close();
  return { t, code, stdout: stdout.text, stderr: stderr.text };
}

describe("print mode", () => {
  it("streams the reply to stdout and exits 0", async () => {
    const result = await print([chatText("Hello there")]);
    expect(result).toEqual(expect.objectContaining({ code: 0, stdout: "Hello there\n", stderr: "" }));
  });

  it("denies writes in ask mode and reports tool lines on stderr", async () => {
    const t = await testSetup([chatTool("call_1", "write_file", { path: "a.txt", content: "new" }), chatText("Could not write")]);
    await writeFile(join(t.root, "a.txt"), "old");
    const result = await print([], {}, t);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("Could not write\n");
    expect(result.stderr).toContain("• Write a.txt");
    expect(result.stderr).toContain("Denied: Write");
    expect(result.stderr).toContain("✗ Write a.txt: The user rejected this write");
    expect(await readFile(join(t.root, "a.txt"), "utf8")).toBe("old");
  });

  it("applies writes in accept-edits mode", async () => {
    const t = await testSetup([chatTool("call_1", "write_file", { path: "a.txt", content: "new" }), chatText("Wrote it")]);
    const result = await print([], { mode: "accept-edits" }, t);
    expect(result.code).toBe(0);
    expect(await readFile(join(t.root, "a.txt"), "utf8")).toBe("new");
  });

  it("exits 1 with the error on stderr when the model fails", async () => {
    const result = await print([]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("oxbit-agent: No scripted model reply");
  });

  it("exits 130 when the signal cancels the turn", async () => {
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 50);
    const result = await print([hanging(chatText("Partial").slice(0, 1))], { signal: abort.signal });
    expect(result.code).toBe(130);
    expect(result.stdout).toBe("Partial\n");
  });

  it("continues a saved session without printing its history", async () => {
    const t = await testSetup([chatText("First answer"), chatText("Second answer")]);
    await print([], {}, t);
    const [saved] = await new (await import("./sessions.js")).JsonlSessionStore(t.config.paths.sessions).list(t.root);
    const result = await print([], { sessionId: saved.id, prompt: "Again" }, t);
    expect(result.stdout).toBe("Second answer\n");
    const messages = (t.fake.requests.filter((request) => request.method === "POST").at(-1)!.body as any).messages;
    expect(messages.map((message: any) => message.content)).toEqual(expect.arrayContaining(["Hi", "First answer", "Again"]));
  });
});
