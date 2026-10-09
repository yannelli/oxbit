import { describe, expect, it } from "vitest";
import { createServer } from "./server.js";
import { DockerfileServer } from "./dockerfile.js";
import type { NativeFileHost } from "./files.js";

function setup() {
  const host: NativeFileHost = { readFile: () => undefined, fileExists: () => false, directoryExists: path => path === "/workspace", list: () => "[]" };
  const server = createServer({ root: "/workspace", rootUri: "file:///workspace", kind: "dockerfile" }, host, files => new DockerfileServer(files));
  const uri = "file:///workspace/Dockerfile";
  const open = (text: string) => server.dispatch("textDocument/didOpen", { textDocument: { uri, text, version: 1, languageId: "dockerfile" } });
  const request = (method: string, params: Record<string, unknown> = {}) => server.dispatch(method, { textDocument: { uri }, ...params });
  return { server, open, request };
}

describe("Dockerfile native language server", () => {
  it("reports invalid instructions and completes instructions", async () => {
    const { server, open, request } = setup();
    expect((await server.dispatch("initialize", {})).error).toBeUndefined();
    const opened = await open("FROM alpine\nEXPOSE abc\nRU");
    expect((opened.notifications[0].params as any).diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: "Invalid containerPort: abc", source: "dockerfile-utils" }),
      expect.objectContaining({ message: "Unknown instruction: RU" }),
    ]));
    const completion = await request("textDocument/completion", { position: { line: 2, character: 2 } });
    expect(completion.result).toContainEqual(expect.objectContaining({ label: "RUN" }));
    const resolved = await server.dispatch("completionItem/resolve", (completion.result as any[]).find(item => item.label === "RUN"));
    expect(JSON.stringify(resolved.result)).toContain("RUN");
    await server.dispatch("exit", null);
  });

  it("answers image tag completion without the Docker Hub client", async () => {
    const { server, open, request } = setup();
    await server.dispatch("initialize", {});
    await open("FROM alpine:3\n");
    const tags = await request("textDocument/completion", { position: { line: 0, character: 13 } });
    expect(tags).toEqual({ result: [], notifications: [] });
    await server.dispatch("exit", null);
  });

  it("hovers, lists symbols, formats, and gives signature help", async () => {
    const { server, open, request } = setup();
    await server.dispatch("initialize", {});
    await open("FROM alpine AS base\n  run   echo hi\nEXPOSE 80\n");
    const hover = await request("textDocument/hover", { position: { line: 0, character: 1 } });
    expect((hover.result as any).contents.value).toContain("FROM baseImage");
    const symbols = await request("textDocument/documentSymbol");
    expect(symbols.result).toContainEqual(expect.objectContaining({ name: "FROM" }));
    const formatted = await request("textDocument/formatting", { options: { tabSize: 4, insertSpaces: true } });
    expect(formatted.result).toContainEqual({ newText: "", range: { start: { line: 1, character: 0 }, end: { line: 1, character: 2 } } });
    const signature = await request("textDocument/signatureHelp", { position: { line: 2, character: 7 } });
    expect((signature.result as any).signatures[0].label).toBe("EXPOSE port ...");
    await server.dispatch("exit", null);
  });
});
