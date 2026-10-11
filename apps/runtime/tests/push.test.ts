import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import http from "node:http";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PUSH_RELAY_URL, type AgentActivityUpdate, type PushRequest } from "@oxbit/sdk";
import { PUSH_DEVICES_FILE, PushDevices, type AgentStatus } from "../src/push.js";
import { AgentACP } from "../src/agent-acp.js";
import { WorkspaceFiles } from "../src/filesystem.js";

const fixture = path.resolve("tests/fixtures/agent-acp/agent.mjs");
const ALERT = "alert-handle_1", LIVE = "live-activity-handle_1";
const snapshot: AgentActivityUpdate = { agent: "Codex", title: "Fix the build", status: "working", detail: "Running tests", pending: 0, startedAt: 1_760_000_000_000 };
const now = () => Math.floor(Date.now() / 1000);

describe("runtime push devices", () => {
  let server: http.Server, relayUrl: string;
  let reply: (request: PushRequest) => [number, unknown] = () => [200, { sent: true }];
  const received: { url?: string; body: PushRequest }[] = [];
  const cleanups: (() => Promise<unknown>)[] = [];
  const previousRelay = process.env.OXBIT_PUSH_RELAY;
  beforeAll(async () => {
    server = http.createServer(async (request, response) => {
      let text = "";
      for await (const chunk of request) text += chunk;
      const body = JSON.parse(text) as PushRequest;
      received.push({ url: request.url, body });
      const [status, result] = reply(body);
      response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(result));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    relayUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    received.splice(0);
    reply = () => [200, { sent: true }];
    if (previousRelay === undefined) delete process.env.OXBIT_PUSH_RELAY;
    else process.env.OXBIT_PUSH_RELAY = previousRelay;
    vi.unstubAllGlobals();
  });
  async function store() {
    process.env.OXBIT_PUSH_RELAY = relayUrl + "/";
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "oxbit-push-"));
    cleanups.push(() => fs.rm(dataDir, { recursive: true, force: true }));
    return { dataDir, devices: await PushDevices.open(dataDir) };
  }
  async function inactive(devices: PushDevices, activity: AgentActivityUpdate | null = snapshot) {
    await devices.register("owner", "phone", { deviceId: "device-1", alert: ALERT, liveActivity: LIVE });
    await devices.state("owner", "phone", { deviceId: "device-1", active: false, activity });
  }
  const status = (value: AgentStatus["status"], pending = 0): AgentStatus =>
    ({ owner: "owner", agent: "Codex", status: value, pending, startedAt: 1_760_000_123_456 });
  const saved = async (dataDir: string) => JSON.parse(await fs.readFile(path.join(dataDir, PUSH_DEVICES_FILE), "utf8"));

  it("validates device, handle, and activity parameters", async () => {
    const { devices } = await store();
    const invalid = { code: "INVALID_PARAMS" };
    await expect(devices.register("owner", "c", { deviceId: "" })).rejects.toMatchObject(invalid);
    await expect(devices.register("owner", "c", { deviceId: "d".repeat(129) })).rejects.toMatchObject(invalid);
    await expect(devices.register("owner", "c", { deviceId: "d", alert: "not+base64url" })).rejects.toMatchObject(invalid);
    await expect(devices.register("owner", "c", { deviceId: "d", liveActivity: "a".repeat(2049) })).rejects.toMatchObject(invalid);
    await devices.register("owner", "c", { deviceId: "d".repeat(128), alert: "a".repeat(2048) });
    await expect(devices.state("owner", "c", { deviceId: "d".repeat(128), active: "no" })).rejects.toMatchObject(invalid);
    for (const activity of [{ ...snapshot, status: "idle" }, { ...snapshot, pending: -1 }, { ...snapshot, title: 7 }, { ...snapshot, startedAt: "now" }, "busy"])
      await expect(devices.state("owner", "c", { deviceId: "d".repeat(128), active: false, activity })).rejects.toMatchObject(invalid);
    await expect(devices.state("owner", "c", { deviceId: "unknown", active: false })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(devices.state("intruder", "c", { deviceId: "d".repeat(128), active: false })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("persists devices across restarts and prunes stale and excess entries", async () => {
    const { dataDir, devices } = await store();
    await inactive(devices);
    await devices.state("owner", "phone", { deviceId: "device-1", active: true });
    await devices.flush();
    const file = await saved(dataDir);
    expect(file.version).toBe(1);
    expect(file.devices).toEqual([expect.objectContaining({
      deviceId: "device-1", session: "owner", alert: ALERT, liveActivity: LIVE,
      active: true, connection: "phone", activity: snapshot, updatedAt: expect.any(Number),
    })]);
    const restarted = await PushDevices.open(dataDir);
    await restarted.notify(status("finished"));
    expect(received.map((r) => Object.keys(r.body))).toEqual([["handle", "alert"], ["handle", "activity"]]);

    const day = 24 * 60 * 60 * 1000;
    const entries = Array.from({ length: 17 }, (_, i) => ({ deviceId: `fresh-${i}`, session: "owner", alert: ALERT, active: false, updatedAt: Date.now() - (17 - i) * 1000 }));
    await fs.writeFile(path.join(dataDir, PUSH_DEVICES_FILE), JSON.stringify({
      version: 1, devices: [...entries, { deviceId: "stale", session: "owner", alert: ALERT, active: false, updatedAt: Date.now() - 31 * day }],
    }));
    const pruned = await PushDevices.open(dataDir);
    await pruned.unregister("owner", { deviceId: "fresh-16" });
    expect((await saved(dataDir)).devices.map((d: { deviceId: string }) => d.deviceId)).toEqual(entries.slice(1, 16).map((d) => d.deviceId));
  });

  it("pushes only while the device is inactive or its connection has closed", async () => {
    const { devices } = await store();
    await devices.register("owner", "phone", { deviceId: "device-1", alert: ALERT, liveActivity: LIVE });
    await devices.notify(status("finished"));
    expect(received).toEqual([]);
    devices.disconnect("other-connection");
    await devices.notify(status("finished"));
    expect(received).toEqual([]);
    devices.disconnect("phone");
    await devices.notify(status("finished"));
    expect(received.map((r) => r.body.alert)).toEqual([{ title: "Agent finished", body: "Codex" }]);
    await devices.state("owner", "tablet", { deviceId: "device-1", active: true });
    devices.disconnect("phone");
    await devices.notify(status("failed"));
    expect(received).toHaveLength(1);
    await devices.state("owner", "tablet", { deviceId: "device-1", active: false, activity: snapshot });
    await devices.notify(status("failed"));
    expect(received).toHaveLength(3);
    await devices.notify({ ...status("failed"), owner: "someone-else" });
    expect(received).toHaveLength(3);
    await devices.register("owner", "relaunched", { deviceId: "device-1", alert: ALERT, liveActivity: LIVE });
    devices.disconnect("tablet");
    await devices.notify(status("failed"));
    expect(received).toHaveLength(3);
    devices.disconnect("relaunched");
    await devices.notify(status("failed"));
    expect(received).toHaveLength(5);
  });

  it("builds alert and Live Activity payloads for each status", async () => {
    const { devices } = await store();
    await inactive(devices);
    await devices.notify(status("working"));
    await devices.notify(status("waiting", 2));
    await devices.notify(status("waiting", 2));
    await devices.notify(status("finished"));
    await devices.state("owner", "phone", { deviceId: "device-1", active: false, activity: snapshot });
    await devices.notify(status("failed"));
    expect(received.every((r) => r.url === "/v1/push")).toBe(true);
    const bodies = received.map((r) => r.body);
    expect(bodies.filter((b) => b.alert).map((b) => [b.handle, b.alert])).toEqual([
      [ALERT, { title: "Agent needs your input", body: "Fix the build" }],
      [ALERT, { title: "Agent needs your input", body: "Fix the build" }],
      [ALERT, { title: "Agent finished", body: "Fix the build" }],
      [ALERT, { title: "Agent turn failed", body: "Fix the build" }],
    ]);
    const activities = bodies.filter((b) => b.activity);
    expect(activities.every((b) => b.handle === LIVE)).toBe(true);
    expect(activities.map((b) => ({ event: b.activity!.event, state: b.activity!.state }))).toEqual([
      { event: "update", state: { status: "working", title: "Fix the build", detail: "Working", pending: 0, startedAt: 1_760_000_123 } },
      { event: "update", state: { status: "waiting", title: "Fix the build", detail: "2 requests need an answer", pending: 2 } },
      { event: "end", state: { status: "finished", title: "Fix the build", detail: "Agent finished", pending: 0 } },
      { event: "end", state: { status: "failed", title: "Fix the build", detail: "Agent turn failed", pending: 0 } },
    ]);
    for (const { activity } of activities) {
      const end = activity!.event === "end";
      expect(end ? activity!.dismissalDate : activity!.staleDate).toBeGreaterThanOrEqual(now() + 899);
      expect(end ? activity!.dismissalDate : activity!.staleDate).toBeLessThanOrEqual(now() + 900);
      expect(end ? activity!.staleDate : activity!.dismissalDate).toBeUndefined();
    }
  });

  it("clears a handle the relay reports gone and survives relay failures", async () => {
    const { dataDir, devices } = await store();
    await inactive(devices);
    reply = (request) => request.alert ? [410, { sent: false, gone: true }] : [500, { sent: false, reason: "APNs unavailable" }];
    await devices.notify(status("finished"));
    await devices.flush();
    const [device] = (await saved(dataDir)).devices;
    expect(device.alert).toBeUndefined();
    expect(device.liveActivity).toBe(LIVE);
    process.env.OXBIT_PUSH_RELAY = "http://127.0.0.1:1";
    await expect(devices.notify(status("waiting", 1))).resolves.toBeUndefined();
  });

  it("uses the default relay when OXBIT_PUSH_RELAY is unset", async () => {
    const { devices } = await store();
    await inactive(devices, null);
    delete process.env.OXBIT_PUSH_RELAY;
    const fetch = vi.fn(async () => new Response(JSON.stringify({ sent: true })));
    vi.stubGlobal("fetch", fetch);
    await devices.notify(status("finished"));
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]).toEqual([`${PUSH_RELAY_URL}/v1/push`, expect.objectContaining({ method: "POST", signal: expect.any(AbortSignal) })]);
  });

  async function agentSetup(listener: (status: AgentStatus) => void) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "oxbit-push-agent-")));
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const events: { name: string; params: any }[] = [];
    const agents = new AgentACP(new WorkspaceFiles(root), (_client, name, params) => events.push({ name, params }), undefined, undefined, listener);
    cleanups.push(async () => agents.dispose());
    const connection = await agents.start("owner", { provider: "codex", command: process.execPath, args: [fixture] });
    await agents.call("owner", connection.id, "session/new");
    const prompt = (text: string) => agents.call("owner", connection.id, "session/prompt", { text });
    return { agents, connection, events, prompt };
  }

  it("reports turn start, permission requests, and turn outcomes from agents", async () => {
    const reports: AgentStatus[] = [];
    const { agents, connection, events, prompt } = await agentSetup((s) => reports.push(s));
    await prompt("Hello");
    await expect(prompt("error")).rejects.toThrow("Fixture prompt failed");
    const permission = prompt("permission");
    await expect.poll(() => events.some((e) => e.name === "acp.request")).toBe(true);
    const request = events.find((e) => e.name === "acp.request")!.params;
    agents.respond("owner", connection.id, request.requestId, { outcome: { outcome: "selected", optionId: request.params.options[0].optionId } });
    await permission;
    const cancelled = prompt("wait");
    await expect.poll(() => reports.length).toBe(8);
    agents.cancel("owner", connection.id);
    await expect(cancelled).resolves.toEqual({ stopReason: "cancelled" });
    expect(reports.map((r) => [r.status, r.pending])).toEqual([
      ["working", 0], ["finished", 0], ["working", 0], ["failed", 0], ["working", 0], ["waiting", 1], ["finished", 0], ["working", 0],
    ]);
    expect(reports.every((r) => r.owner === "owner" && r.agent && typeof r.startedAt === "number")).toBe(true);
  });

  it("finishes the turn when the relay is unreachable", async () => {
    const { devices } = await store();
    await inactive(devices);
    process.env.OXBIT_PUSH_RELAY = "http://127.0.0.1:1";
    const { prompt } = await agentSetup((s) => void devices.notify(s));
    await expect(prompt("Hello")).resolves.toEqual({ stopReason: "end_turn" });
  });
});
