import { describe, expect, it, vi } from "vitest";
import { TOOLS, bash, builtinTools, relativePath, resolvePath, runTool } from "./tools.js";
import type { ToolContext } from "./extensions.js";

const call = (name: string, args: unknown) => ({ id: `call-${name}`, name, arguments: JSON.stringify(args) });
function context(files: Record<string, string> = {}) {
  const updates: any[] = [];
  const request = vi.fn(async (method: string, params: any) => {
    const path = params.path?.slice("/root/".length);
    if (method === "fs/read_text_file") {
      if (!(path in files)) throw new Error("Missing");
      return { content: files[path] };
    }
    if (method === "fs/write_text_file") {
      files[path] = params.content;
      return null;
    }
    return { diagnostics: [{ path: "a.ts", line: 2, character: 3, message: "Bad", source: "ts" }] };
  });
  const value: Omit<ToolContext, "toolCallId"> = {
    root: "/root", sessionId: "session", mode: "ask", signal: new AbortController().signal, request, update: (update) => updates.push(update),
    filesystem: { list: vi.fn(async () => [{ path: "src", name: "src", kind: "directory" }, { path: "a.ts", name: "a.ts", kind: "file" }]) } as any,
  };
  return { context: value, updates, request, files };
}

describe("workspace paths", () => {
  it("resolves relative paths under the root and rejects escapes", () => {
    expect(resolvePath("/root", "src/./a/../b.ts")).toEqual({ relative: "src/b.ts", absolute: "/root/src/b.ts" });
    expect(resolvePath("/root", undefined)).toEqual({ relative: "", absolute: "/root" });
    for (const path of ["../x", "a/../../x", "/etc/passwd", "a\\b", "a\0b", 3])
      expect(() => resolvePath("/root", path)).toThrow();
    expect(relativePath("/root", "/root/a/b.ts")).toBe("a/b.ts");
    for (const path of ["/rootx/a", "/other", "/root/../x", "/root", "a"])
      expect(() => relativePath("/root", path)).toThrow();
  });
  it("fails a tool call whose path leaves the workspace without a client request", async () => {
    const { context: tools, request, updates } = context();
    const result = await runTool(call("read_file", { path: "../secret" }), tools);
    expect(result).toEqual(expect.objectContaining({ error: true, output: expect.stringContaining("outside the workspace") }));
    expect(request).not.toHaveBeenCalled();
    expect(updates.map((update) => [update.sessionUpdate, update.status])).toEqual([["tool_call", "in_progress"], ["tool_call_update", "failed"]]);
  });
});

describe("tools", () => {
  it("reads through the client with absolute paths and 0-based locations", async () => {
    const { context: tools, request, updates } = context({ "a.ts": "one\ntwo" });
    expect((await runTool(call("read_file", { path: "a.ts", line: 2, limit: 1 }), tools)).output).toBe("one\ntwo");
    expect(request).toHaveBeenCalledWith("fs/read_text_file", expect.objectContaining({ path: "/root/a.ts", line: 2, limit: 1, sessionId: "session" }));
    expect(updates[0]).toEqual(expect.objectContaining({ kind: "read", locations: [{ path: "/root/a.ts", line: 1 }] }));
  });
  it("replaces one exact string and reports a diff before the write review", async () => {
    const { context: tools, request, updates, files } = context({ "a.ts": "const a = 1;\nconst b = 1;\n" });
    const result = await runTool(call("edit_file", { path: "a.ts", old_string: "a = 1", new_string: "a = 2" }), tools);
    expect(result.error).toBeUndefined();
    expect(files["a.ts"]).toBe("const a = 2;\nconst b = 1;\n");
    expect(updates[1]).toEqual(expect.objectContaining({ content: [{ type: "diff", path: "/root/a.ts", oldText: "const a = 1;\nconst b = 1;\n", newText: files["a.ts"] }] }));
    expect(request.mock.calls.map(([method]) => method)).toEqual(["fs/read_text_file", "fs/write_text_file"]);
    const ambiguous = await runTool(call("edit_file", { path: "a.ts", old_string: "= ", new_string: "=" }), tools);
    expect(ambiguous).toEqual(expect.objectContaining({ error: true, output: expect.stringContaining("matches 2 times") }));
  });
  it("writes a new file with an empty old text and returns a rejected review to the model", async () => {
    const { context: tools, updates, request } = context();
    await runTool(call("write_file", { path: "new.ts", content: "x" }), tools);
    expect(updates[1].content[0]).toEqual({ type: "diff", path: "/root/new.ts", oldText: null, newText: "x" });
    request.mockRejectedValueOnce(new Error("Missing")).mockRejectedValueOnce(new Error("Error: The user rejected this change"));
    expect((await runTool(call("write_file", { path: "new.ts", content: "y" }), tools)).output).toContain("rejected");
  });
  it("lists directories, reads diagnostics, updates the plan and rejects bad arguments", async () => {
    const { context: tools, updates, request } = context();
    expect((await runTool(call("list_files", {}), tools)).output).toBe("src/\na.ts");
    expect((await runTool(call("diagnostics", { path: "a.ts" }), tools)).output).toBe("a.ts:2:3 [ts] Bad");
    expect(request).toHaveBeenLastCalledWith("oxbit/diagnostics", expect.objectContaining({ path: "a.ts" }));
    await runTool(call("update_plan", { entries: [{ content: "Do it", status: "pending" }] }), tools);
    expect(updates).toContainEqual({ sessionUpdate: "plan", entries: [{ content: "Do it", status: "pending", priority: "medium" }] });
    expect((await runTool({ id: "x", name: "read_file", arguments: "{" }, tools)).output).toBe("Tool arguments are not valid JSON");
    expect((await runTool(call("search", { query: "a" }), tools)).output).toBe("Search is unavailable in this workspace");
  });
});

describe("bash", () => {
  function terminal(exit: Promise<unknown>) {
    const updates: any[] = [];
    const abort = new AbortController();
    const request = vi.fn(async (method: string, _params: any): Promise<any> => {
      if (method === "terminal/create") return { terminalId: "t1" };
      if (method === "terminal/wait_for_exit") return exit;
      if (method === "terminal/output") return { output: "out\n", truncated: false };
      return null;
    });
    const context = { root: "/root", sessionId: "s", mode: "full-auto" as const, signal: abort.signal, request, update: (update: any) => updates.push(update),
      filesystem: {} as any };
    return { context, request, updates, abort, methods: () => request.mock.calls.map(([method]) => method) };
  }
  it("is offered only with the terminal capability", () => {
    expect(builtinTools({ fs: true, terminal: false })).toEqual(TOOLS);
    expect(builtinTools({ fs: false, terminal: true }).at(-1)).toBe(bash);
  });
  it("leaves out diagnostics when the host has nothing to answer it", () => {
    expect(builtinTools({ fs: true, terminal: false, diagnostics: false }).map((tool) => tool.spec.name)).not.toContain("diagnostics");
  });
  it("runs bash -c through ACP terminal requests and embeds the terminal in the tool call", async () => {
    const t = terminal(Promise.resolve({ exitCode: 0, signal: null }));
    const result = await runTool(call("bash", { command: "ls -la", cwd: "src" }), t.context, [bash]);
    expect(result).toEqual({ id: "call-bash", name: "bash", output: "out\n[Exit code 0]" });
    expect(t.request).toHaveBeenNthCalledWith(1, "terminal/create", { sessionId: "s", command: "bash", args: ["-c", "ls -la"], cwd: "/root/src", outputByteLimit: 100000 });
    expect(t.methods()).toEqual(["terminal/create", "terminal/wait_for_exit", "terminal/output", "terminal/release"]);
    expect(t.updates).toContainEqual({ sessionUpdate: "tool_call_update", toolCallId: "call-bash", content: [{ type: "terminal", terminalId: "t1" }] });
    expect(t.updates[0]).toEqual(expect.objectContaining({ kind: "execute", title: "ls -la" }));
  });
  it("fails on a non-zero exit with the output", async () => {
    const t = terminal(Promise.resolve({ exitCode: 2, signal: null }));
    expect(await runTool(call("bash", { command: "false" }), t.context, [bash])).toEqual(expect.objectContaining({ error: true, output: "out\n[Exit code 2]" }));
  });
  it("kills and releases the terminal when the turn is cancelled", async () => {
    const t = terminal(new Promise(() => {}));
    const running = runTool(call("bash", { command: "sleep 100" }), t.context, [bash]);
    await expect.poll(() => t.methods()).toContain("terminal/wait_for_exit");
    t.abort.abort();
    expect(await running).toEqual(expect.objectContaining({ error: true, output: "out\n[Cancelled by the user]" }));
    expect(t.methods()).toEqual(["terminal/create", "terminal/wait_for_exit", "terminal/kill", "terminal/output", "terminal/release"]);
  });
  it("kills the command after timeout_ms", async () => {
    const t = terminal(new Promise(() => {}));
    const result = await runTool(call("bash", { command: "sleep 100", timeout_ms: 20 }), t.context, [bash]);
    expect(result.output).toBe("out\n[Timed out after 20 ms]");
    expect(t.methods()).toContain("terminal/kill");
  });
});
