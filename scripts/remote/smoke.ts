/** Real SSH acceptance, confined to an ephemeral Docker container and temporary keys. */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { createRequire } from "node:module";
import { connectSsh, type RemoteFrame } from "../../apps/runtime/src/ssh.js";
const { WebSocket } = createRequire(
  new URL("../../apps/runtime/package.json", import.meta.url),
)("ws");
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "oxbit-ssh-test-"));
const fixture = `oxbit-ssh-test-${randomBytes(4).toString("hex")}`;
const run = (cmd: string, args: string[]) =>
  execFileSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const docker = (...args: string[]) => run("docker", args);
const checks: string[] = [];
let connection: Awaited<ReturnType<typeof connectSsh>> | undefined;
let socket: any;
let sequence = 0;
const events: any[] = [];
const pending = new Map<
  string,
  {
    resolve: (value: any) => void;
    reject: (error: any) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();
async function authenticate(port: number, token: string) {
  socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
    origin: "tauri://localhost",
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.on("message", (raw: Buffer) => {
    const message = JSON.parse(raw.toString());
    if (message.type === "event") events.push(message);
    const entry = pending.get(message.id);
    if (entry) {
      clearTimeout(entry.timer);
      pending.delete(message.id);
      if (message.error) entry.reject(message.error);
      else entry.resolve(message.result);
    }
  });
  return request("auth.authenticate", { token });
}
function request(method: string, params: object = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = `ssh-${++sequence}`;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, 30000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ v: 1, type: "request", id, method, params }));
  });
}
async function until(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 15000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
if (process.platform === "darwin") {
  const helpers = "/Applications/Docker.app/Contents/Resources/bin";
  if (await fs.stat(helpers).catch(() => undefined)) process.env.PATH = helpers + path.delimiter + (process.env.PATH ?? "");
}
try {
  console.log("Building an isolated SSH host (no Node or npm)…");
  execFileSync(
    "docker",
    [
      "build",
      "--platform",
      "linux/amd64",
      "-f",
      "scripts/remote/sshd.Dockerfile",
      "-t",
      "oxbit-ssh-test:local",
      "scripts/remote",
    ],
    { stdio: "inherit" },
  );
  run("ssh-keygen", [
    "-q",
    "-t",
    "ed25519",
    "-N",
    "",
    "-f",
    path.join(temp, "identity"),
  ]);
  docker(
    "run",
    "-d",
    "--name",
    fixture,
    "--platform",
    "linux/amd64",
    "--cap-add",
    "NET_ADMIN",
    "-p",
    "127.0.0.1::22",
    "-v",
    `${path.join(temp, "identity.pub")}:/test-key:ro`,
    "oxbit-ssh-test:local",
  );
  docker(
    "exec",
    fixture,
    "sh",
    "-c",
    "cp /test-key /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys && ip route del default",
  );
  const port = docker("port", fixture, "22/tcp").split(":").at(-1)!;
  const hostKey = docker(
    "exec",
    fixture,
    "cat",
    "/etc/ssh/ssh_host_ed25519_key.pub",
  );
  await fs.writeFile(
    path.join(temp, "known_hosts"),
    `[127.0.0.1]:${port} ${hostKey}\n`,
  );
  const config = path.join(temp, "config");
  await fs.writeFile(
    config,
    `Host oxbit-test\n HostName 127.0.0.1\n User root\n Port ${port}\n IdentityFile ${path.join(temp, "identity")}\n UserKnownHostsFile ${path.join(temp, "known_hosts")}\n IdentitiesOnly yes\n`,
    { mode: 0o600 },
  );
  assert.equal(
    docker("exec", fixture, "sh", "-c", "command -v node || true"),
    "",
  );
  checks.push("SSH-only target, no Node/npm, no outbound network");
  const token = randomBytes(32).toString("hex");
  const target = "ssh://oxbit-test/~/project/hello.ts";
  const workspaceKey = createHash("sha256").update(target).digest("hex");
  const progress: string[] = [];
  const frames: RemoteFrame[] = [];
  const options = {
    target,
    workspaceKey,
    token,
    sshConfig: config,
    payloadDirectory: path.resolve(
      "apps/desktop/src-tauri/resources/runtime/remote",
    ),
    onProgress: (message: string) => {
      progress.push(message);
      console.log(message);
    },
    onFrame: (frame: RemoteFrame) => frames.push(frame),
  };
  connection = await connectSsh(options);
  assert(progress.some((line) => line.includes("Installing")));
  assert.equal(connection.openFile, "hello.ts");
  assert.equal(connection.root, "/root/project");
  const info = await authenticate(connection.port, token);
  assert.equal(info.trusted, false);
  await assert.rejects(
    request("terminal.create"),
    (e: any) => e.code === "UNTRUSTED",
  );
  await assert.rejects(connectSsh(options), /already open/);
  checks.push(
    "automatic verified installation, remote file target, authenticated tunnel, trust gate, concurrent owner rejection",
  );
  const text = 'const greeting = "hello";\ngreeting.\n';
  await request("fs.write", { path: "main.ts", text, expectedRevision: null });
  assert.equal((await request("fs.read", { path: "main.ts" })).text, text);
  await assert.rejects(
    request("fs.write", {
      path: "main.ts",
      text: "wrong",
      expectedRevision: null,
    }),
    (e: any) => e.code === "CONFLICT",
  );
  await assert.rejects(request("fs.read", { path: "../.ssh/authorized_keys" }));
  assert(
    JSON.stringify(
      await request("search.query", { query: "greeting" }),
    ).includes("main.ts"),
  );
  checks.push(
    "remote read/write, optimistic save conflicts, path boundary, bundled ripgrep search",
  );
  await request("workspace.trust", { trusted: true });
  const taskCatalog = await request("tasks.catalog");
  const taskSource = taskCatalog.sources.find((source: any) => source.id === taskCatalog.defaultSourceId);
  const serviceCode = 'require("http").createServer((request,response)=>response.end("remote task tunnel")).listen(+process.env.OXBIT_PORT,process.env.OXBIT_HOST)';
  const savedTasks = await request("tasks.save", { sourceId: taskSource.id, name: "SSH service", task: { command: "${OXBIT_RUNTIME_NODE}", execution: "process", args: ["-e", serviceCode], type: "service", ready: { url: "http://$OXBIT_HOST:$OXBIT_PORT/", intervalMs: 100 } }, expectedRevision: taskSource.revision });
  const serviceTask = savedTasks.tasks.find((task: any) => task.name === "SSH service");
  const serviceRun = await request("tasks.start", { taskId: serviceTask.id });
  await until(() => events.some(event => event.event === "tasks.status" && event.params.id === serviceRun.id && event.params.state === "ready"), "Remote task did not become ready");
  const serviceStatus = [...events].reverse().find(event => event.event === "tasks.status" && event.params.id === serviceRun.id && event.params.state === "ready")!.params;
  assert.equal(await (await fetch(serviceStatus.links[0])).text(), "remote task tunnel");
  assert.equal(new URL(serviceStatus.links[0]).hostname, "127.0.0.1");
  assert.equal(serviceStatus.variables.OXBIT_PROJECT_DIR, "/root/project");
  await request("tasks.stop", { id: serviceRun.id, force: true });
  await until(() => events.some(event => event.event === "tasks.exit" && event.params.id === serviceRun.id), "Remote task did not stop");
  checks.push("remote configured service, automatic task port tunnel, HTTP link, assigned variables and force stop");

  assert(await request("git.status"));
  const terminal = await request("terminal.create", { cols: 80, rows: 24 });
  await request("terminal.resize", { id: terminal.id, cols: 92, rows: 31 });
  await request("terminal.input", {
    id: terminal.id,
    data: "pwd; stty size\n",
  });
  await until(
    () =>
      events.some(
        (e) => e.event === "terminal.data" && e.params.data.includes("31 92"),
      ),
    "Remote PTY resize/output failed",
  );
  assert(
    events.some(
      (e) =>
        e.event === "terminal.data" && e.params.data.includes("/root/project"),
    ),
  );
  const lsp = await request("lsp.start");
  assert(lsp.capabilities);
  const uri = "file:///root/project/main.ts";
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
  assert(JSON.stringify(completion).includes("toUpperCase"));
  assert(!frames.some((frame) => frame.type === "process"));
  checks.push(
    "remote Git, real PTY and resize, bundled TypeScript completion, remote PID isolation",
  );
  const rotated = randomBytes(32).toString("hex");
  connection.send({
    version: 1,
    type: "rotate",
    token: rotated,
    request: "rotate-smoke",
  });
  await until(
    () =>
      frames.some(
        (frame) => frame.type === "rotated" && frame.request === "rotate-smoke",
      ),
    "Token rotation not acknowledged",
  );
  socket.close();
  await assert.rejects(
    authenticate(connection.port, token),
    (e: any) => e.code === "UNAUTHENTICATED",
  );
  socket.close();
  await authenticate(connection.port, rotated);
  socket.close();
  await connection.close();
  await connection.closed;
  assert.equal(
    docker("exec", fixture, "sh", "-c", "pgrep -a node || true"),
    "",
  );
  checks.push(
    "token rotation and stale credential rejection, shutdown reaps remote runtime and tools",
  );
  progress.length = 0;
  connection = await connectSsh(options);
  assert(!progress.some((line) => line.includes("Installing")));
  await authenticate(connection.port, token);
  assert.equal((await request("fs.read", { path: "main.ts" })).text, text);
  assert.deepEqual(await request("terminal.list"), []);
  checks.push(
    "cached offline reconnect, persisted files and trust, no stale terminals",
  );
  socket.close();
  // Simulate SSH transport loss; the remote runtime must see EOF and stop its tools.
  docker("exec", fixture, "sh", "-c", "pkill -P 1 || true");
  await Promise.race([
    connection.closed,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("Disconnect was not detected")),
        15000,
      ).unref(),
    ),
  ]);
  await until(
    () => docker("exec", fixture, "sh", "-c", "pgrep -a node || true") === "",
    "Remote node process survived SSH loss",
  );
  checks.push("SSH transport loss detected and remote processes reaped");
  await fs.mkdir("evidence/remote-ssh", { recursive: true });
  await fs.writeFile(
    "evidence/remote-ssh/results.json",
    JSON.stringify(
      {
        result: "passed",
        remote: "Linux x64 Debian bookworm, isolated Docker SSH server",
        checks,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(JSON.stringify({ result: "passed", checks }, null, 2));
} finally {
  socket?.close();
  await connection?.close();
  for (const entry of pending.values()) clearTimeout(entry.timer);
  try {
    docker("rm", "-f", fixture);
  } catch {
    /* May not have started. */
  }
  await fs.rm(temp, { recursive: true, force: true });
}
