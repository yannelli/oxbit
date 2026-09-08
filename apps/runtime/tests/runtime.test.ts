import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocket } from "ws";
import * as Y from "yjs";
import { createRuntime } from "../src/runtime.js";
import { DocumentService } from "../../../packages/documents/src/index.js";
import type { FileSystem, Persistence } from "@oxbit/sdk";
import { runCommand } from "../src/processes.js";
import { encode, decode, WorkspaceFiles } from "../src/filesystem.js";

class Client {
  sequence = 0;
  events: { event: string; params: any; seq?: number }[] = [];
  pending = new Map<
    string,
    { resolve: (value: any) => void; reject: (error: any) => void }
  >();
  constructor(readonly socket: WebSocket) {
    socket.on("message", (bytes) => {
      const message = JSON.parse(bytes.toString());
      if (message.type === "event") {
        this.events.push(message);
        if (this.events.length > 10000) this.events.shift();
      } else {
        const entry = this.pending.get(message.id);
        if (entry) {
          this.pending.delete(message.id);
          if (message.error) entry.reject(message.error);
          else entry.resolve(message.result);
        }
      }
    });
  }
  request(
    method: string,
    params: Record<string, unknown> = {},
    id = `test-${++this.sequence}`,
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(
        JSON.stringify({ v: 1, type: "request", id, method, params }),
      );
    });
  }
  async event(
    name: string,
    predicate: (params: any) => boolean = () => true,
    timeout = 15000,
  ) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const event = this.events.find(
        (e) => e.event === name && predicate(e.params),
      );
      if (event) return event.params;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for ${name}`);
  }
  close() {
    this.socket.close();
  }
}

describe("authenticated runtime with real services", () => {
  let directory: string,
    root: string,
    runtime: Awaited<ReturnType<typeof createRuntime>>,
    token: string,
    client: Client;
  const clients: Client[] = [];
  async function connect(sessionToken = token) {
    const socket = new WebSocket(`ws://127.0.0.1:${runtime.port}/ws`, {
      origin: `http://127.0.0.1:${runtime.port}`,
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const value = new Client(socket);
    clients.push(value);
    await value.request("auth.authenticate", { token: sessionToken });
    return value;
  }
  beforeAll(async () => {
    directory = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), "oxbit-runtime-"),
    );
    root = path.join(directory, "workspace");
    await fs.mkdir(root);
    await fs.writeFile(
      path.join(root, "hello.ts"),
      'export const greeting = "hello";\n',
    );
    runtime = await createRuntime({
      root,
      tasksHome: directory,
      port: 0,
      dataDir: path.join(directory, "state"),
      pairingCode: "test-pair-code",
    });
    const response = await fetch(`http://127.0.0.1:${runtime.port}/api/pair`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: `http://127.0.0.1:${runtime.port}`,
      },
      body: JSON.stringify({ code: runtime.pairingCode }),
    });
    token = (await response.json()).token;
    client = await connect();
  }, 20000);
  afterAll(async () => {
    for (const c of clients) c.close();
    await runtime?.close();
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  }, 20000);
  it("requires authentication, origin approval and trust", async () => {
    const denied = await fetch(`http://127.0.0.1:${runtime.port}/api/pair`, {
      method: "POST",
      headers: {
        Origin: "https://evil.example",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ code: runtime.pairingCode }),
    });
    expect(denied.status).toBe(403);
    expect((await client.request("tasks.catalog")).projectId).toMatch(
      /^[a-f0-9-]{36}$/,
    );
    await expect(
      client.request("tasks.run", { command: "echo denied" }),
    ).rejects.toMatchObject({ code: "UNTRUSTED" });
    await expect(client.request("terminal.create")).rejects.toMatchObject({
      code: "UNTRUSTED",
    });
    await expect(
      client.request("fs.list", { workspaceId: "another" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const socket = new WebSocket(`ws://127.0.0.1:${runtime.port}/ws`, {
      origin: `http://127.0.0.1:${runtime.port}`,
    });
    await new Promise<void>((resolve) => socket.once("open", resolve));
    const guest = new Client(socket);
    clients.push(guest);
    await expect(guest.request("fs.list")).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
    expect(await client.request("workspace.trust", { trusted: true })).toEqual({
      trusted: true,
    });
  });
  it("edits configured tasks only as owner and enforces execution grants", async () => {
    const catalog = await client.request("tasks.catalog"),
      source = catalog.sources.find((item: any) => item.private);
    const updated = await client.request("tasks.save", {
      sourceId: source.id,
      name: "rpc test",
      task: { command: "printf 'configured rpc task\\n'" },
      expectedRevision: source.revision,
    });
    const task = updated.tasks.find((task: any) => task.name === "rpc test");
    const grant = await client.request("workspace.grant", {
      capabilities: ["tasks"],
    });
    const guest = await connect(grant.token);
    await expect(
      guest.request("tasks.save", {
        sourceId: source.id,
        name: "rpc test",
        task: { command: "false" },
        expectedRevision: updated.sources.find((item: any) => item.private)
          .revision,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const run = await guest.request("tasks.start", { taskId: task.id });
    expect(
      (await guest.event("tasks.exit", (params) => params.id === run.id))
        .exitCode,
    ).toBe(0);
    await expect(
      client.request("tasks.stop", { id: run.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await client.request("workspace.revoke", { id: grant.sessionId });
  });
  it("checks revisions, escaping paths and symlinks and revokes scoped grants", async () => {
    const snapshot = await client.request("fs.read", { path: "hello.ts" });
    const written = await client.request("fs.write", {
      path: "hello.ts",
      text: snapshot.text + "// saved\n",
      expectedRevision: snapshot.revision,
    });
    expect(written.revision).not.toBe(snapshot.revision);
    await expect(
      client.request("fs.write", {
        path: "hello.ts",
        text: "stale",
        expectedRevision: snapshot.revision,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      client.request("fs.read", { path: "../state/runtime.json" }),
    ).rejects.toMatchObject({ code: "PATH_DENIED" });
    await fs.symlink(directory, path.join(root, "escape"));
    await expect(
      client.request("fs.read", { path: "escape/state/runtime.json" }),
    ).rejects.toMatchObject({ code: "PATH_DENIED" });
    await expect(
      client.request("fs.write", {
        path: "escape/new.txt",
        text: "escape",
        expectedRevision: null,
      }),
    ).rejects.toMatchObject({ code: "PATH_DENIED" });
    const grant = await client.request("workspace.grant", {
      capabilities: ["filesystem.read"],
    });
    const restricted = await connect(grant.token);
    expect(
      (await restricted.request("fs.read", { path: "hello.ts" })).text,
    ).toContain("saved");
    await expect(
      restricted.request("fs.write", {
        path: "blocked",
        text: "x",
        expectedRevision: null,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(restricted.request("terminal.create")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await client.request("workspace.revoke", { id: grant.sessionId });
    await expect(connect(grant.token)).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
  });
  it("serializes competing saves and validates encoding conversions", async () => {
    const snapshot = await client.request("fs.read", { path: "hello.ts" });
    const writes = await Promise.allSettled([
      client.request("fs.write", {
        path: "hello.ts",
        text: "first\n",
        expectedRevision: snapshot.revision,
      }),
      client.request("fs.write", {
        path: "hello.ts",
        text: "second\n",
        expectedRevision: snapshot.revision,
      }),
    ]);
    expect(writes.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    for (const encoding of [
      "utf-8",
      "utf-8-bom",
      "utf-16le",
      "latin1",
    ] as const) {
      const text =
        encoding === "latin1" ? "caf\u00e9\n" : "\u65e5\u672c\ud83d\ude80\n";
      const bytes = encode(text, encoding, "CRLF");
      expect(decode(bytes, encoding)).toEqual({ text, encoding, eol: "CRLF" });
    }
    expect(() => encode("\ud83d\ude80", "latin1")).toThrow("Latin-1");
    expect(() => decode(Buffer.from([0xc3, 0x28]))).toThrow("Cannot decode");
    const direct = new WorkspaceFiles(root);
    await fs.writeFile(path.join(root, "readonly.txt"), "locked", {
      mode: 0o444,
    });
    const read = await direct.read("readonly.txt");
    await expect(
      direct.write("readonly.txt", "changed", {
        expectedRevision: read.revision,
      }),
    ).rejects.toMatchObject({ code: "READ_ONLY" });
  });
  it("searches actual files with ripgrep and reports UTF-16 editor ranges", async () => {
    await fs.writeFile(
      path.join(root, "search.txt"),
      "\ud83d\ude80 target target\nTarget\n",
    );
    const matches = await client.request("search.query", {
      query: "target",
      include: "*.txt",
      caseSensitive: true,
      wholeWord: true,
    });
    expect(matches).toHaveLength(2);
    expect(matches[0]).toMatchObject({
      path: "search.txt",
      line: 1,
      column: 4,
      from: 3,
      to: 9,
    });
    const filtered = await client.request("search.query", {
      query: "target",
      exclude: "search.txt",
    });
    expect(filtered).toHaveLength(0);
  });
  it("executes real PTYs and tasks with resize, cancellation and reconnect replay", async () => {
    const terminal = await client.request("terminal.create", {
      cols: 90,
      rows: 25,
    });
    await client.request("terminal.resize", {
      id: terminal.id,
      cols: 110,
      rows: 35,
    });
    await client.request("terminal.input", {
      id: terminal.id,
      data: "printf 'OXBIT_PTY_\\u2713\\n'\r",
    });
    await client.event(
      "terminal.data",
      (p) => p.id === terminal.id && p.data.includes("OXBIT_PTY_"),
    );
    const peer = await connect();
    const replay = await peer.request("terminal.attach", {
      id: terminal.id,
      afterSeq: 0,
    });
    expect(replay.chunks.length).toBeGreaterThan(0);
    await peer.request("terminal.ack", { id: terminal.id, seq: replay.seq });
    const task = await client.request("tasks.run", {
      command: "printf 'task-done\\n'",
    });
    expect(
      (await client.event("tasks.exit", (p) => p.id === task.id)).exitCode,
    ).toBe(0);
    await client.event(
      "tasks.data",
      (p) => p.id === task.id && p.data.includes("task-done"),
    );
    const long = await client.request("tasks.run", { command: "sleep 30" });
    await client.request("tasks.cancel", { id: long.id });
    await client.event("tasks.exit", (p) => p.id === long.id);
    await client.request("terminal.kill", { id: terminal.id });
    await client.event("terminal.exit", (p) => p.id === terminal.id);
  }, 20000);
  it("makes a real commit and deduplicates non-idempotent requests", async () => {
    await client.request("git.init");
    await runCommand("git", ["config", "user.name", "Oxbit Test"], {
      cwd: root,
    });
    await runCommand("git", ["config", "user.email", "oxbit@example.test"], {
      cwd: root,
    });
    await client.request("git.stage", { path: "hello.ts" });
    expect(
      (await client.request("git.status")).changes.some(
        (c: any) => c.path === "hello.ts" && c.index === "A",
      ),
    ).toBe(true);
    const commit = await client.request(
      "git.commit",
      { message: "test: create real editor commit" },
      "one-commit",
    );
    expect(commit.commit).toMatch(/^[a-f0-9]{40}$/);
    const repeated = await client.request(
      "git.commit",
      { message: "test: duplicate must not execute" },
      "one-commit",
    );
    expect(repeated.commit).toBe(commit.commit);
    expect(
      (
        await runCommand("git", ["rev-list", "--count", "HEAD"], { cwd: root })
      ).stdout.trim(),
    ).toBe("1");
    expect(
      (await client.request("operation.status", { id: "one-commit" })).status,
    ).toBe("completed");
    await runCommand("git", ["branch", "other"], { cwd: root });
    await client.request("git.checkout", { branch: "other" });
    expect((await client.request("git.status")).branch).toBe("other");
  }, 15000);
  it("merges independent Yjs edits, persists drafts and uses one disk writer", async () => {
    await fs.writeFile(path.join(root, "shared.ts"), "seed\n");
    const peer = await connect();
    const a = await client.request("collab.join", { path: "shared.ts" }),
      b = await peer.request("collab.join", { path: "shared.ts" });
    const left = new Y.Doc(),
      right = new Y.Doc();
    Y.applyUpdate(left, Buffer.from(a.update, "base64"));
    Y.applyUpdate(right, Buffer.from(b.update, "base64"));
    left.getText("content").insert(0, "left ");
    right.getText("content").insert(0, "right ");
    await Promise.all([
      client.request("collab.update", {
        path: "shared.ts",
        update: Buffer.from(Y.encodeStateAsUpdate(left)).toString("base64"),
      }),
      peer.request("collab.update", {
        path: "shared.ts",
        update: Buffer.from(Y.encodeStateAsUpdate(right)).toString("base64"),
      }),
    ]);
    const merged = await client.request("collab.join", { path: "shared.ts" });
    Y.applyUpdate(left, Buffer.from(merged.update, "base64"));
    Y.applyUpdate(right, Buffer.from(merged.update, "base64"));
    expect(left.getText("content").toString()).toBe(
      right.getText("content").toString(),
    );
    expect(left.getText("content").toString()).toContain("left ");
    expect(left.getText("content").toString()).toContain("right ");
    expect(await fs.readFile(path.join(root, "shared.ts"), "utf8")).toBe(
      "seed\n",
    );
    const saved = await client.request("collab.save", {
      path: "shared.ts",
      expectedRevision: a.revision,
    });
    expect(await fs.readFile(path.join(root, "shared.ts"), "utf8")).toBe(
      saved.text,
    );
    left.getText("content").insert(0, "draft ");
    await client.request("collab.update", {
      path: "shared.ts",
      update: Buffer.from(Y.encodeStateAsUpdate(left)).toString("base64"),
    });
    await fs.writeFile(path.join(root, "shared.ts"), "external\n");
    await client.event("collab.conflict", (p) => p.path === "shared.ts");
    await expect(
      client.request("collab.save", {
        path: "shared.ts",
        expectedRevision: saved.revision,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    left.destroy();
    right.destroy();
  }, 15000);
  it("uses a real TypeScript server for completion, diagnostics, navigation, rename and code actions", async () => {
    const text =
      'import { helper } from "./helper";\nexport function greet(name: string) { return name.toUpperCase(); }\nconst message: string = 42;\nconst result = greet("Oxbit");\nconsole.log(result);\n';
    await fs.writeFile(
      path.join(root, "helper.ts"),
      "export const helper = 1;\n",
    );
    await fs.writeFile(path.join(root, "language.ts"), text);
    await fs.writeFile(
      path.join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          target: "ES2022",
          module: "ESNext",
          noUnusedLocals: true,
        },
        include: ["*.ts"],
      }),
    );
    const started = await client.request("lsp.start");
    expect(started.capabilities.completionProvider).toBeTruthy();
    const uri = pathToFileURL(path.join(root, "language.ts")).href;
    await client.request("lsp.notify", {
      method: "textDocument/didOpen",
      params: {
        textDocument: { uri, languageId: "typescript", version: 1, text },
      },
    });
    const diagnostic = await client.event(
      "lsp.notification",
      (p) =>
        p.method === "textDocument/publishDiagnostics" &&
        p.params.uri === uri &&
        p.params.diagnostics.some((d: any) => d.code === 2322),
      25000,
    );
    expect(
      diagnostic.params.diagnostics.some((d: any) => d.code === 2322),
    ).toBe(true);
    const completion = await client.request("lsp.request", {
      method: "textDocument/completion",
      params: { textDocument: { uri }, position: { line: 4, character: 8 } },
    });
    expect(
      (completion.items ?? completion).some(
        (item: any) => item.label === "log",
      ),
    ).toBe(true);
    const definition = await client.request("lsp.request", {
      method: "textDocument/definition",
      params: { textDocument: { uri }, position: { line: 3, character: 17 } },
    });
    expect(definition.length).toBeGreaterThan(0);
    const rename = await client.request("lsp.request", {
      method: "textDocument/rename",
      params: {
        textDocument: { uri },
        position: { line: 1, character: 18 },
        newName: "welcome",
      },
    });
    expect(JSON.stringify(rename)).toContain("welcome");
    const actions = await client.request("lsp.request", {
      method: "textDocument/codeAction",
      params: {
        textDocument: { uri },
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 },
        },
        context: { diagnostics: [], only: ["source.removeUnusedImports.ts"] },
      },
    });
    expect(actions.length).toBeGreaterThan(0);
    const runtimeFiles: FileSystem = {
      id: "runtime-test",
      list: (path = "") => client.request("fs.list", { path }),
      read: (path) => client.request("fs.read", { path }),
      write: (path, text, options) =>
        client.request("fs.write", { path, text, ...options }),
      mkdir: async (path) => {
        await client.request("fs.mkdir", { path });
      },
      rename: async (path, to) => {
        await client.request("fs.rename", { path, to });
      },
      delete: async (path) => {
        await client.request("fs.delete", { path });
      },
      watch: () => ({ dispose() {} }),
    };
    const values = new Map<string, unknown>(),
      persistence: Persistence = {
        get: async <T>(key: string) => values.get(key) as T | undefined,
        set: async (key, value) => {
          values.set(key, value);
        },
        delete: async (key) => {
          values.delete(key);
        },
      };
    const documents = new DocumentService(runtimeFiles, persistence),
      document = await documents.open("language.ts");
    const action = actions.find((action: any) => action.edit);
    expect(action).toBeTruthy();
    const edit = action.edit,
      changes =
        edit.documentChanges
          ?.filter((change: any) => change.textDocument)
          .flatMap((change: any) => change.edits) ??
        edit.changes?.[uri] ??
        [];
    const lines = document.text.toString().split("\n"),
      offset = (position: { line: number; character: number }) =>
        lines
          .slice(0, position.line)
          .reduce((sum, line) => sum + line.length + 1, 0) + position.character;
    await documents.applyEdits([
      {
        path: "language.ts",
        expectedVersion: document.version,
        expectedRevision: document.savedRevision,
        edits: changes.map((change: any) => ({
          from: offset(change.range.start),
          to: offset(change.range.end),
          insert: change.newText,
        })),
      },
    ]);
    expect(document.text.toString()).not.toContain("import { helper }");
    await documents.save("language.ts");
    expect(
      await fs.readFile(path.join(root, "language.ts"), "utf8"),
    ).not.toContain("import { helper }");
    await documents.dispose();
    await expect(
      client.request("lsp.request", {
        method: "textDocument/hover",
        params: {
          textDocument: { uri: "file:///etc/passwd" },
          position: { line: 0, character: 0 },
        },
      }),
    ).rejects.toMatchObject({ code: "PATH_DENIED" });
    const restarted = await client.request("lsp.restart");
    expect(restarted.capabilities.renameProvider).toBeTruthy();
    expect(
      (
        await client.request("lsp.request", {
          method: "textDocument/definition",
          params: {
            textDocument: { uri },
            position: { line: 3, character: 17 },
          },
        })
      ).length,
    ).toBeGreaterThan(0);
    await client.request("lsp.stop");
    expect(await client.request("lsp.status")).toMatchObject({ state: "stopped", paused: true });
    await expect(client.request("lsp.request", {
      method: "textDocument/hover", params: { textDocument: { uri }, position: { line: 0, character: 1 } },
    })).rejects.toMatchObject({ code: "LSP_STOPPED" });
    await client.request("lsp.notify", {
      method: "textDocument/didChange",
      params: { textDocument: { uri, version: 20 }, contentChanges: [{ text }] },
    });
    expect(await client.request("lsp.status")).toMatchObject({ state: "stopped" });
    await client.request("lsp.start");
    expect(await client.request("lsp.status")).toMatchObject({ state: "ready", paused: false });
  }, 60000);
  it("recovers collaboration drafts and operation status after runtime restart", async () => {
    for (const c of clients) c.close();
    await runtime.close();
    runtime = await createRuntime({
      root,
      tasksHome: directory,
      port: 0,
      dataDir: path.join(directory, "state"),
      pairingCode: "test-pair-code",
    });
    client = await connect();
    expect(
      (await client.request("operation.status", { id: "one-commit" })).status,
    ).toBe("completed");
    const room = await client.request("collab.join", { path: "shared.ts" });
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Buffer.from(room.update, "base64"));
    expect(doc.getText("content").toString()).toContain("draft ");
    expect(room.conflict).toBe(true);
    doc.destroy();
    expect(await client.request("terminal.list")).toEqual([]);
  }, 20000);
});
