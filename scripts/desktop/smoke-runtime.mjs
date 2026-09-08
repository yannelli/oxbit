import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
const { WebSocket } = createRequire(
  new URL("../../apps/runtime/package.json", import.meta.url),
)("ws");
const supplied = process.argv[2];
const source = supplied
  ? path.resolve(supplied)
  : fileURLToPath(
      new URL(
        "../../apps/desktop/src-tauri/resources/runtime",
        import.meta.url,
      ),
    );
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "Oxbit desktop 空间 "));
const stage = path.join(temp, "Read only runtime");
await fs.cp(source, stage, { recursive: true });
async function readOnly(dir) {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    assert(!e.isSymbolicLink(), `Staged runtime contains symlink: ${p}`);
    if (e.isDirectory()) await readOnly(p);
    else await fs.chmod(p, (await fs.stat(p)).mode & 0o111 ? 0o555 : 0o444);
  }
  await fs.chmod(dir, 0o555);
}
await readOnly(stage);
const workspace = path.join(temp, "Project café");
await fs.mkdir(workspace);
await fs.mkdir(path.join(temp, "home"));
const root = await fs.realpath(workspace);
const token = randomBytes(32).toString("hex");
const key = createHash("sha256").update(root).digest("hex");
let child;
let socket;
const groups = new Set();
const environment = {
  PATH: "/usr/bin:/bin",
  HOME: path.join(temp, "home"),
  SHELL: "/bin/sh",
  LANG: "en_US.UTF-8",
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function launch() {
  child = spawn(
    path.join(stage, "bin/node"),
    [path.join(stage, "desktop.js")],
    {
      cwd: temp,
      env: environment,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-4096);
  });
  const lines = createInterface({ input: child.stdout });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Supervisor readiness timed out")),
      20000,
    );
    child.once("error", reject);
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("Runtime exited before ready: " + stderr));
    });
    lines.on("line", (line) => {
      const msg = JSON.parse(line);
      assert.equal(msg.version, 1);
      if (msg.type === "process") {
        if (msg.running) groups.add(msg.pid);
        else groups.delete(msg.pid);
      }
      if (msg.type === "error") reject(new Error(msg.message));
      if (msg.type === "ready") {
        clearTimeout(timer);
        resolve(msg);
      }
    });
  });
  child.stdin.write(
    JSON.stringify({
      version: 1,
      type: "launch",
      root,
      dataDir: path.join(temp, "state"),
      workspaceKey: key,
      token,
      rgPath: path.join(stage, "bin/rg"),
    }) + "\n",
  );
  const frame = await ready;
  assert.equal(frame.workspaceKey, key);
  assert.equal(frame.root, root);
  assert(frame.port > 0);
  return frame.port;
}
const events = [];
const pending = new Map();
let seq = 0;
async function connect(port) {
  socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
    origin: "tauri://localhost",
  });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === "event") events.push(msg);
    const item = pending.get(msg.id);
    if (item) {
      clearTimeout(item.timer);
      pending.delete(msg.id);
      if (msg.error) item.reject(msg.error);
      else item.resolve(msg.result);
    }
  });
  await assert.rejects(
    request("auth.authenticate", { token: "wrong" }),
    (e) => e.code === "UNAUTHENTICATED",
  );
  return request("auth.authenticate", { token });
}
function request(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = `smoke-${++seq}`;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, 30000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ v: 1, type: "request", id, method, params }));
  });
}
async function until(predicate, message) {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message);
    await sleep(30);
  }
}
try {
  const port = await launch();
  const info = await connect(port);
  assert.equal(info.trusted, false);
  await assert.rejects(
    request("terminal.create"),
    (e) => e.code === "UNTRUSTED",
  );
  assert.equal(
    (
      await fetch(`http://127.0.0.1:${port}/api/pair`, {
        method: "POST",
        body: "{}",
      })
    ).status,
    403,
  );
  await new Promise((resolve, reject) => {
    const denied = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      origin: "https://evil.example",
    });
    denied.on("error", resolve);
    denied.on("open", () => {
      denied.close();
      reject(new Error("Untrusted origin accepted"));
    });
  });
  const text = 'const greeting = "hello";\ngreeting.\n';
  await request("fs.write", { path: "main.ts", text, expectedRevision: null });
  assert.equal((await request("fs.read", { path: "main.ts" })).text, text);
  const found = await request("search.query", { query: "greeting" });
  assert(JSON.stringify(found).includes("main.ts"));
  await request("workspace.trust", { trusted: true });
  const terminal = await request("terminal.create", { cols: 80, rows: 24 });
  await request("terminal.resize", { id: terminal.id, cols: 92, rows: 31 });
  await request("terminal.input", {
    id: terminal.id,
    data: "printf 'OXBIT_PTY_OK'; stty size\n",
  });
  await until(
    () =>
      events.some(
        (e) => e.event === "terminal.data" && e.params.data.includes("31 92"),
      ),
    "Real PTY did not resize/output",
  );
  const lsp = await request("lsp.start");
  assert(lsp.capabilities);
  const uri = pathToFileURL(path.join(root, "main.ts")).href;
  await request("lsp.notify", {
    method: "textDocument/didOpen",
    params: {
      textDocument: { uri, languageId: "typescript", version: 1, text },
    },
  });
  const completion = await request("lsp.request", {
    method: "textDocument/completion",
    params: { textDocument: { uri }, position: { line: 1, character: 9 } },
  });
  assert(
    JSON.stringify(completion).includes("toUpperCase"),
    "Packaged TypeScript completion absent",
  );
  socket.close();
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.stdin.end(); // Parent channel loss must clean up terminals and the language server.
  await exited;
  for (const pid of groups)
    assert.throws(() => process.kill(pid, 0), "Orphaned tool process");
  const secondPort = await launch();
  const restored = await connect(secondPort);
  assert.equal(restored.workspaceKey, key);
  assert.equal((await request("fs.read", { path: "main.ts" })).text, text);
  assert.deepEqual(await request("terminal.list"), []);
  console.log(
    JSON.stringify(
      {
        platform: `${process.platform}-${process.arch}`,
        result: "passed",
        checks: [
          "private readiness",
          "minimal environment",
          "read-only resources",
          "spaces and Unicode",
          "authentication",
          "origin rejection",
          "workspace trust",
          "filesystem",
          "bundled ripgrep",
          "real PTY resize/output",
          "bundled TypeScript completion",
          "parent-loss cleanup",
          "restart identity",
        ],
      },
      null,
      2,
    ),
  );
} finally {
  socket?.close();
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.stdin.end();
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* Exited. */
      }
    }, 5000);
    await exited;
    clearTimeout(timer);
  }
  // Restore permissions only in this disposable copy so cleanup works for non-root builders.
  async function writable(dir) {
    await fs.chmod(dir, 0o755);
    for (const e of await fs.readdir(dir, { withFileTypes: true }))
      if (e.isDirectory()) await writable(path.join(dir, e.name));
  }
  await writable(stage);
  await fs.rm(temp, { recursive: true, force: true });
}
