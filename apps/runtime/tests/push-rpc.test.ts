import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import type { AgentActivityUpdate, PushRequest } from "@oxbit/sdk";
import { createRuntime } from "../src/runtime.js";
import { PUSH_DEVICES_FILE } from "../src/push.js";

const fixture = path.resolve("tests/fixtures/agent-acp/agent.mjs");
const activity: AgentActivityUpdate = { agent: "Codex", title: "Phone thread", status: "working", detail: "Working", pending: 0 };

class Client {
  private sequence = 0;
  private pending = new Map<string, { resolve: (value: any) => void; reject: (error: any) => void }>();
  constructor(readonly socket: WebSocket) {
    socket.on("message", (bytes) => {
      const message = JSON.parse(bytes.toString());
      const entry = message.type === "response" ? this.pending.get(message.id) : undefined;
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(message.error);
      else entry.resolve(message.result);
    });
  }
  request(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = `push-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ v: 1, type: "request", id, method, params }));
    });
  }
  async close() {
    const closed = new Promise((resolve) => this.socket.once("close", resolve));
    this.socket.close();
    await closed;
  }
}

describe("push RPCs on a runtime", () => {
  let directory: string, runtime: Awaited<ReturnType<typeof createRuntime>>, relay: http.Server;
  const received: PushRequest[] = [];
  const previousRelay = process.env.OXBIT_PUSH_RELAY;
  async function pair() {
    const response = await fetch(`http://127.0.0.1:${runtime.port}/api/pair`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: runtime.pairingCode }),
    });
    return (await response.json()).token as string;
  }
  async function connect(token: string) {
    const socket = new WebSocket(`ws://127.0.0.1:${runtime.port}/ws`, { origin: "tauri://localhost" });
    await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    const client = new Client(socket);
    await client.request("auth.authenticate", { token });
    return client;
  }
  beforeAll(async () => {
    relay = http.createServer(async (request, response) => {
      let text = "";
      for await (const chunk of request) text += chunk;
      if (request.url === "/v1/push") received.push(JSON.parse(text));
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ sent: true }));
    });
    await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
    process.env.OXBIT_PUSH_RELAY = `http://127.0.0.1:${(relay.address() as { port: number }).port}`;
    directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "oxbit-push-rpc-"));
    const root = path.join(directory, "workspace");
    await fs.mkdir(root);
    runtime = await createRuntime({
      root, tasksHome: directory, port: 0, dataDir: path.join(directory, "state"),
      projectsDir: path.join(directory, "projects"), settingsFile: path.join(directory, "settings.json"),
      pairingCode: "push-pair-code",
    });
  }, 20000);
  afterAll(async () => {
    await runtime?.close();
    await new Promise((resolve) => relay.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
    if (previousRelay === undefined) delete process.env.OXBIT_PUSH_RELAY;
    else process.env.OXBIT_PUSH_RELAY = previousRelay;
  });

  it("requires trust and owner access and validates parameters", async () => {
    const token = await pair(), owner = await connect(token);
    await expect(owner.request("push.register", { deviceId: "phone" })).rejects.toMatchObject({ code: "UNTRUSTED" });
    await owner.request("workspace.trust", { trusted: true });
    const grant = await owner.request("workspace.grant", { capabilities: ["extensions"] });
    const guest = await connect(grant.token);
    await expect(guest.request("push.register", { deviceId: "phone" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    for (const params of [{}, { deviceId: "" }, { deviceId: "x".repeat(129) }, { deviceId: "phone", alert: "a/b" }, { deviceId: "phone", liveActivity: "a".repeat(2049) }])
      await expect(owner.request("push.register", params)).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    expect(await owner.request("push.register", { deviceId: "phone", alert: "alert_handle" })).toEqual({});
    await expect(owner.request("push.state", { deviceId: "phone", active: false, activity: { ...activity, status: "done" } })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    await expect(owner.request("push.state", { deviceId: "tablet", active: false })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await owner.request("push.unregister", { deviceId: "phone" })).toEqual({});
    await guest.close();
    await owner.close();
  });

  it("pushes agent outcomes after the app goes inactive or its connection closes", async () => {
    const token = await pair(), desktop = await connect(token);
    await desktop.request("workspace.trust", { trusted: true });
    const agent = await desktop.request("acp.start", { provider: "codex", command: process.execPath, args: [fixture] });
    await desktop.request("acp.call", { id: agent.id, method: "session/new" });
    const prompt = () => desktop.request("acp.call", { id: agent.id, method: "session/prompt", params: { text: "Hello" } });

    const phone = await connect(token);
    await phone.request("push.register", { deviceId: "phone", alert: "alert_handle", liveActivity: "activity_handle" });
    await prompt();
    expect(received).toEqual([]);

    await phone.request("push.state", { deviceId: "phone", active: false, activity });
    await prompt();
    await expect.poll(() => received.length).toBe(3);
    const kinds = () => received.map((r) => r.alert?.title ?? `${r.activity!.event}:${r.activity!.state.status}`).sort();
    expect(kinds()).toEqual(["Agent finished", "end:finished", "update:working"]);
    expect(received.find((r) => r.alert)).toEqual({ handle: "alert_handle", alert: { title: "Agent finished", body: "Phone thread" } });

    await phone.request("push.state", { deviceId: "phone", active: true });
    await prompt();
    expect(received).toHaveLength(3);
    await phone.close();
    await prompt();
    await expect.poll(() => received.length).toBe(6);
    expect(kinds()).toEqual(["Agent finished", "Agent finished", "end:finished", "end:finished", "update:working", "update:working"]);

    const saved = async () => JSON.parse(await fs.readFile(path.join(runtime.dataDir, PUSH_DEVICES_FILE), "utf8"));
    await expect.poll(saved).toMatchObject({ version: 1, devices: [{ deviceId: "phone", active: false, activity, alert: "alert_handle", liveActivity: "activity_handle" }] });
    await desktop.close();
  });
});
