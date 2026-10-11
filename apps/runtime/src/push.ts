import * as fs from "node:fs/promises";
import path from "node:path";
import { RpcError, requireString } from "@oxbit/protocol";
import { PUSH_RELAY_URL, type AgentActivityUpdate, type PushActivityState, type PushRequest, type PushResponse } from "@oxbit/sdk";

type Status = AgentActivityUpdate["status"];
/** Reported by AgentACP when a turn starts, waits for input, or ends. */
export interface AgentStatus {
  owner: string;
  agent: string;
  status: Status;
  pending: number;
  /** Milliseconds since the epoch. */
  startedAt?: number;
}
export interface PushDevice {
  deviceId: string;
  session: string;
  alert?: string;
  liveActivity?: string;
  active: boolean;
  activity?: AgentActivityUpdate;
  connection?: string;
  updatedAt: number;
}
type HandleKind = "alert" | "liveActivity";

export const PUSH_DEVICES_FILE = "push-devices.json";
const MAX_DEVICES = 16;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const WINDOW_SECONDS = 15 * 60;
const RELAY_TIMEOUT_MS = 10_000;
const HANDLE = /^[A-Za-z0-9_-]{1,2048}$/;
const STATUSES: Status[] = ["working", "waiting", "finished", "failed"];
const TITLES = { waiting: "Agent needs your input", finished: "Agent finished", failed: "Agent turn failed" } as const;

const log = (message: string) => process.stderr.write(`Oxbit push: ${message}\n`);
function deviceIdOf(params: Record<string, unknown>) {
  const value = requireString(params, "deviceId", 128);
  if (!value) throw new RpcError("INVALID_PARAMS", "Invalid deviceId");
  return value;
}
function handleOf(params: Record<string, unknown>, key: HandleKind) {
  const value = params[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !HANDLE.test(value)) throw new RpcError("INVALID_PARAMS", `Invalid ${key}`);
  return value;
}
const text = (value: unknown): value is string => typeof value === "string" && value.length <= 1024;
/** Validates an `AgentActivityUpdate`; `null` means the app has no activity. */
export function activityOf(value: unknown): AgentActivityUpdate | null {
  if (value === null) return null;
  const v = (value ?? {}) as Record<string, unknown>;
  const startedAt = v.startedAt;
  if (
    typeof value !== "object" || !text(v.agent) || !text(v.title) || !text(v.detail) ||
    !STATUSES.includes(v.status as Status) || !Number.isSafeInteger(v.pending) || (v.pending as number) < 0 ||
    (startedAt !== undefined && (typeof startedAt !== "number" || !Number.isFinite(startedAt) || startedAt < 0))
  )
    throw new RpcError("INVALID_PARAMS", "Invalid activity");
  return {
    agent: v.agent, title: v.title, status: v.status as Status, detail: v.detail, pending: v.pending as number,
    ...(startedAt === undefined ? {} : { startedAt: startedAt as number }),
  };
}
function restore(entry: Record<string, unknown>): PushDevice | undefined {
  try {
    const activity = entry.activity === undefined ? null : activityOf(entry.activity);
    const device: PushDevice = {
      deviceId: deviceIdOf(entry), session: requireString(entry, "session", 128),
      alert: handleOf(entry, "alert"), liveActivity: handleOf(entry, "liveActivity"),
      active: false, ...(activity ? { activity } : {}), updatedAt: entry.updatedAt as number,
    };
    return Number.isFinite(device.updatedAt) ? device : undefined;
  } catch {
    return undefined;
  }
}
function detail(status: Status, pending: number) {
  if (status === "working") return "Working";
  if (status === "waiting") return pending === 1 ? "1 request needs an answer" : `${pending} requests need an answer`;
  return TITLES[status];
}
function activityState(snapshot: AgentActivityUpdate, event: AgentStatus): PushActivityState {
  return {
    status: event.status, title: snapshot.title, detail: detail(event.status, event.pending), pending: event.pending,
    ...(event.status === "working" && event.startedAt !== undefined ? { startedAt: Math.floor(event.startedAt / 1000) } : {}),
  };
}

/** Devices registered through `push.*` and the relay pushes sent to them while their app is inactive. */
export class PushDevices {
  private devices = new Map<string, PushDevice>();
  /** Last Live Activity state sent per device. */
  private sent = new Map<string, string>();
  private persistence = Promise.resolve();
  private constructor(private file: string) {}
  static async open(dataDir: string) {
    const store = new PushDevices(path.join(dataDir, PUSH_DEVICES_FILE));
    try {
      const state = JSON.parse(await fs.readFile(store.file, "utf8"));
      if (state?.version === 1 && Array.isArray(state.devices))
        for (const entry of state.devices) {
          const device = entry && typeof entry === "object" ? restore(entry) : undefined;
          if (device) store.devices.set(device.deviceId, device);
        }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") log(`ignoring unreadable ${PUSH_DEVICES_FILE}: ${String(error)}`);
    }
    store.prune();
    return store;
  }
  async register(session: string, connection: string, params: Record<string, unknown>) {
    const deviceId = deviceIdOf(params), alert = handleOf(params, "alert"), liveActivity = handleOf(params, "liveActivity");
    const previous = this.devices.get(deviceId);
    this.sent.delete(deviceId);
    this.devices.set(deviceId, {
      ...previous,
      deviceId, session, alert, liveActivity, active: true, connection, updatedAt: Date.now(),
    });
    await this.persist();
    return {};
  }
  async state(session: string, connection: string, params: Record<string, unknown>) {
    const deviceId = deviceIdOf(params);
    if (typeof params.active !== "boolean") throw new RpcError("INVALID_PARAMS", "active must be boolean");
    const activity = params.activity === undefined ? undefined : activityOf(params.activity);
    const device = this.devices.get(deviceId);
    if (!device || device.session !== session) throw new RpcError("NOT_FOUND", "Register the device first");
    device.active = params.active;
    if (params.active) device.connection = connection;
    if (activity) device.activity = activity;
    else if (activity === null) delete device.activity;
    device.updatedAt = Date.now();
    this.sent.delete(deviceId);
    await this.persist();
    return {};
  }
  async unregister(session: string, params: Record<string, unknown>) {
    const deviceId = deviceIdOf(params);
    if (this.devices.get(deviceId)?.session === session) {
      this.devices.delete(deviceId);
      this.sent.delete(deviceId);
      await this.persist();
    }
    return {};
  }
  /** Marks devices inactive when the connection that set them active closes. */
  disconnect(connection: string) {
    let changed = false;
    for (const device of this.devices.values())
      if (device.active && device.connection === connection) {
        device.active = false;
        changed = true;
      }
    if (changed) this.persist().catch((error: unknown) => log(`cannot save devices: ${String(error)}`));
  }
  /** Sends alert and Live Activity pushes to the owner's inactive devices; resolves after every send settles. */
  async notify(event: AgentStatus) {
    const sends: Promise<void>[] = [];
    for (const device of this.devices.values()) {
      if (device.active || device.session !== event.owner) continue;
      if (event.status !== "working" && device.alert)
        sends.push(this.send(device.deviceId, "alert", {
          handle: device.alert,
          alert: { title: TITLES[event.status], body: device.activity?.title || event.agent },
        }));
      if (!device.liveActivity || !device.activity) continue;
      const state = activityState(device.activity, event), end = event.status === "finished" || event.status === "failed";
      const key = JSON.stringify([end, state]);
      if (this.sent.get(device.deviceId) === key) continue;
      this.sent.set(device.deviceId, key);
      const window = Math.floor(Date.now() / 1000) + WINDOW_SECONDS;
      sends.push(this.send(device.deviceId, "liveActivity", {
        handle: device.liveActivity,
        activity: { event: end ? "end" : "update", state, ...(end ? { dismissalDate: window } : { staleDate: window }) },
      }));
    }
    await Promise.all(sends);
  }
  flush() {
    return this.persistence.catch(() => {});
  }
  private async send(deviceId: string, kind: HandleKind, request: PushRequest) {
    const relay = (process.env.OXBIT_PUSH_RELAY ?? PUSH_RELAY_URL).replace(/\/+$/, "");
    try {
      const response = await fetch(`${relay}/v1/push`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
      });
      const result = (await response.json().catch(() => ({}))) as Partial<PushResponse>;
      const device = this.devices.get(deviceId);
      if (result.gone && device?.[kind] === request.handle) {
        delete device[kind];
        if (kind === "liveActivity") this.sent.delete(deviceId);
        await this.persist();
      } else if (!response.ok || !result.sent)
        log(`relay did not send to ${deviceId}: ${result.reason ?? `HTTP ${response.status}`}`);
    } catch (error) {
      log(`push to ${deviceId} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  private prune(now = Date.now()) {
    for (const [id, device] of this.devices)
      if (now - device.updatedAt > RETENTION_MS) this.devices.delete(id);
    const oldest = [...this.devices.values()].sort((a, b) => a.updatedAt - b.updatedAt);
    for (const device of oldest.slice(0, Math.max(0, oldest.length - MAX_DEVICES))) this.devices.delete(device.deviceId);
    for (const id of this.sent.keys()) if (!this.devices.has(id)) this.sent.delete(id);
  }
  private persist() {
    this.prune();
    const payload = JSON.stringify({ version: 1, devices: [...this.devices.values()] });
    this.persistence = this.persistence
      .catch(() => {})
      .then(async () => {
        await fs.writeFile(this.file + ".tmp", payload, { mode: 0o600 });
        await fs.rename(this.file + ".tmp", this.file);
      });
    return this.persistence;
  }
}
