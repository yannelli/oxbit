// Pairs a device with `oxbit remote serve` through a local `oxbit-relay` (wrangler dev), opens a folder,
// reconnects with the paired key, and checks that revoking the device ends access. Run: bun run remote-access:e2e
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { RemoteHost, readPairingLink } from "../packages/host-runtime/src/index.js";
import { generateX25519KeyPair } from "../packages/sdk/src/tunnel/index.js";

const root = path.resolve(import.meta.dirname, "..");
const cli = path.join(root, "apps/runtime/dist/index.js");
const children: ChildProcess[] = [];

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

async function until<T>(label: string, probe: () => Promise<T | undefined>, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe().catch(() => undefined);
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function parseLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return line;
  }
}

function stopAll() {
  for (const child of children.splice(0)) {
    if (!child.pid || child.exitCode !== null) continue;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
}
process.on("exit", stopAll);

function oxbit(env: NodeJS.ProcessEnv, args: string[]): Promise<{ code: number; lines: unknown[] }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env, stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code: code ?? 1, lines: out.trim().split("\n").filter(Boolean).map(parseLine) }));
  });
}

function firstLine(env: NodeJS.ProcessEnv, args: string[]): Promise<Record<string, unknown>> {
  const child = spawn(process.execPath, [cli, ...args], { env, stdio: ["ignore", "pipe", "inherit"], detached: true });
  children.push(child);
  return new Promise((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk;
      const end = out.indexOf("\n");
      if (end >= 0) resolve(JSON.parse(out.slice(0, end)));
    });
    child.on("exit", (code) => reject(new Error(`oxbit ${args.join(" ")} exited ${code} before printing`)));
  });
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Failed: ${message}`);
  console.log(`ok - ${message}`);
}

async function main() {
  if (!existsSync(cli)) throw new Error("Build the runtime first: bun run --cwd apps/runtime build");
  const work = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "oxbit-remote-e2e-")));
  const home = path.join(work, "home");
  const project = path.join(home, "proj");
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(project, "README.md"), "# e2e\n");
  const relayPort = await freePort();
  const env = { ...process.env, HOME: home, OXBIT_REMOTE_DIR: path.join(work, "remote"), OXBIT_RELAY: `ws://127.0.0.1:${relayPort}` };

  const relay = spawn("npx", ["-y", "wrangler@4.149.0", "dev", "--local", "--port", String(relayPort), "--ip", "127.0.0.1"], {
    cwd: path.join(root, "apps/relay"), stdio: ["ignore", "ignore", "ignore"], detached: true,
  });
  children.push(relay);
  await until("the relay", async () => ((await fetch(`http://127.0.0.1:${relayPort}/health`)).ok ? true : undefined), 120_000);
  console.log(`relay on ${relayPort}`);

  const enabled = await oxbit(env, ["remote", "enable", "--no-service", "--no-pair", "--json"]);
  check(enabled.code === 0, "enable --no-service");
  const serve = spawn(process.execPath, [cli, "remote", "serve"], { env, stdio: ["ignore", "ignore", "inherit"], detached: true });
  children.push(serve);
  await until("the host on the relay", async () => {
    const { lines } = await oxbit(env, ["remote", "status", "--json"]);
    const status = lines[0] as { relay?: { connected?: boolean } } | undefined;
    return status?.relay?.connected ? true : undefined;
  });
  check(true, "host authenticated to the relay");

  const offerLine = await firstLine(env, ["remote", "pair", "--json"]);
  const offer = await readPairingLink(String(offerLine.link));
  delete offer.l;
  const deviceKey = await generateX25519KeyPair();
  const options = { deviceKey, deviceName: "e2e device", heartbeatMs: 0 };
  const paired = await RemoteHost.pair(offer, options);
  check(paired.status().via === "relay", "paired through the relay with IKpsk2");
  const info = await paired.info();
  check(info.home === home, "host.info reports the host home folder");
  const listing = await paired.list(home);
  check(listing.entries.some((entry) => entry.name === "proj"), "host.list shows the project folder");
  const client = await paired.connectRuntime(project);
  const files = await client.request<{ entries?: { name: string }[] }>("fs.list", { path: "" });
  check(JSON.stringify(files).includes("README.md"), "runtime fs.list over the tunnel");
  client.dispose();
  const record = paired.record;
  paired.dispose();

  const again = new RemoteHost(record, options);
  await again.connect();
  check(again.status().state === "online", "reconnected with IK using the paired key");
  const projects = await again.projects();
  check(projects.projects.some((item) => item.path === project && item.running), "host.projects lists the running folder");
  again.dispose();

  const revoked = await oxbit(env, ["remote", "revoke", "e2e device", "--json"]);
  check(revoked.code === 0, "revoke the device");
  const removed = new RemoteHost(record, { ...options, retryMs: [] });
  const failure = await removed.connect().then(() => undefined, (error: Error) => error);
  check(failure !== undefined, `revoked device cannot connect (${failure?.message})`);
  removed.dispose();

  await oxbit(env, ["--stop", project]).catch(() => undefined);
  await fs.rm(work, { recursive: true, force: true });
}

main()
  .then(() => console.log("remote access e2e passed"), (error: Error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  })
  .finally(stopAll);
