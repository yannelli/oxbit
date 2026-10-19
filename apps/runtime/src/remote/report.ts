import { localName } from "../lan.js";
import type { HostStatus, OfferTicket } from "./host.js";
import { ipcRequest } from "./ipc.js";
import type { OfferOutcome } from "./offers.js";
import type { ServiceManager } from "./service.js";
import * as state from "./state.js";
import type { Environment } from "../daemon.js";

/** Writes one line of text, or one JSON object per line with `--json`. */
export interface Output {
  json: boolean;
  line(text: string): void;
  object(value: unknown): void;
}

/** QR seam for the pairing link: returns terminal text to print above it, or undefined. */
export function renderQr(_link: string): string | undefined {
  return undefined;
}

const clock = (ms: number) => new Date(ms).toLocaleTimeString();
const day = (ms: number) => new Date(ms).toLocaleDateString();

export function ago(ms: number, now = Date.now()) {
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86400)} d ago`;
}

const deviceFields = ({ id, name, pairedAt, lastSeen }: state.Device) => ({ id, name, pairedAt, lastSeen });

/** Asks the running host for an offer, prints it, and waits for a device to use it. */
export async function pair(paths: state.RemotePaths, out: Output, linkOnly: boolean): Promise<number> {
  const ticket = await ipcRequest<OfferTicket>(paths.socket, "offer.create");
  if (out.json) out.object({ link: ticket.link, expiresAt: ticket.expiresAt, host: ticket.host });
  else {
    out.line(`Pair a device with "${ticket.host.name}".`);
    const qr = linkOnly ? undefined : renderQr(ticket.link);
    if (qr) out.line(qr);
    out.line(ticket.link);
    out.line(
      `${qr ? "Scan the code with the Camera app, or open" : "Open"} the link on the device or paste it into Oxbit's Runtime page. It works once and expires at ${clock(ticket.expiresAt)}.`,
    );
  }
  const outcome = await ipcRequest<OfferOutcome>(paths.socket, "offer.wait", { offer: ticket.offer }, Math.max(0, ticket.expiresAt - Date.now()) + 15_000);
  if ("paired" in outcome) {
    if (out.json) out.object({ paired: outcome.paired });
    else out.line(`✓ "${outcome.paired.name}" paired.`);
    return 0;
  }
  if (out.json) out.object({ expired: true });
  else out.line('The pairing link expired before a device used it. Run "oxbit remote pair" for a new one.');
  return 1;
}

const liveStatus = (paths: state.RemotePaths) => ipcRequest<HostStatus>(paths.socket, "status", {}, 5000).catch(() => undefined);

export async function status(paths: state.RemotePaths, env: Environment, manager: ServiceManager | undefined, out: Output): Promise<number> {
  const live = await liveStatus(paths);
  const enabled = manager ? await manager.installed() : false;
  const config = await state.loadConfig(paths, env, false).catch(() => undefined);
  const devices = live?.devices ?? (await state.readDevices(paths).catch(() => []));
  const hostId = live?.id ?? (await state.readHostId(paths)) ?? null;
  const name = live?.name ?? localName();
  if (out.json) {
    out.object({
      enabled,
      running: live !== undefined,
      hostId,
      name,
      relay: { url: live?.relay.url ?? config?.relay ?? null, connected: live?.relay.connected ?? false, state: live?.relay.state ?? "off" },
      lan: { port: live?.lan.port ?? null, addresses: live?.lan.addresses ?? [] },
      devices: devices.map(deviceFields),
    });
    return live ? 0 : 1;
  }
  out.line(`Remote access: ${enabled ? `on (login item ${manager!.file})` : "login item not installed"}`);
  out.line(`Host: "${name}" ${hostId ?? "(no keys yet)"}, ${live ? `running (pid ${live.pid})` : "not running"}`);
  if (live) {
    const relayState = live.relay.state === "replaced" ? "replaced by another host with the same id" : live.relay.state;
    out.line(`Relay: ${live.relay.url}, ${relayState}`);
    out.line(`LAN: ${live.lan.addresses.join(", ") || `port ${live.lan.port}`}`);
  } else if (config) out.line(`Relay: ${config.relay}`);
  const connected = live?.devices.filter((device) => device.connected).length ?? 0;
  out.line(`Devices: ${devices.length} paired${connected ? `, ${connected} connected` : ""}`);
  return live ? 0 : 1;
}

export async function devices(paths: state.RemotePaths, out: Output): Promise<number> {
  const live = await liveStatus(paths);
  const list: Array<state.Device & { connected?: boolean }> = live?.devices ?? (await state.readDevices(paths));
  if (out.json) {
    out.object({ devices: list.map((device) => ({ ...deviceFields(device), ...(live ? { connected: device.connected === true } : {}) })) });
    return 0;
  }
  if (!list.length) out.line('No paired devices. Run "oxbit remote pair" to add one.');
  for (const device of list)
    out.line(`${device.name}  ${device.id.slice(0, 10)}  paired ${day(device.pairedAt)}  ${device.connected ? "connected" : `last seen ${ago(device.lastSeen)}`}`);
  return 0;
}

export async function revoke(paths: state.RemotePaths, query: string, out: Output): Promise<number> {
  let device: state.Device;
  if (await liveStatus(paths)) device = (await ipcRequest<{ device: state.Device }>(paths.socket, "revoke", { device: query })).device;
  else {
    const list = await state.readDevices(paths);
    const match = state.matchDevice(list, query);
    if ("error" in match) throw Object.assign(new Error(match.error), { code: "NOT_FOUND" });
    device = match.device;
    await state.writeDevices(paths, list.filter((entry) => entry.id !== device.id));
  }
  if (out.json) out.object({ revoked: { id: device.id, name: device.name } });
  else out.line(`Revoked "${device.name}". It must pair again to connect.`);
  return 0;
}

export async function reset(paths: state.RemotePaths, out: Output): Promise<number> {
  const running = (await liveStatus(paths)) !== undefined;
  const id = running ? (await ipcRequest<{ id: string }>(paths.socket, "reset", {}, 30_000)).id : (await state.resetHost(paths)).id;
  if (out.json) out.object({ hostId: id, running });
  else out.line(`New host id ${id}. Paired devices were removed; each device must pair again.`);
  return 0;
}
