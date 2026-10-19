import os from "node:os";
import { createOffer, offerLink, type HostHello, type KeyPair } from "@oxbit/sdk/tunnel";
import { advertise as mdnsAdvertise, type Advertisement, type Advertiser } from "../mdns.js";
import { localName, wildcardHost } from "../lan.js";
import { runtimeVersion } from "../version.js";
import type { Environment } from "../daemon.js";
import { PathPolicy } from "./browse.js";
import { DeviceConnection, HANDSHAKE_TIMEOUT_MS, type ConnectionHost } from "./connection.js";
import { listProjects, serveControl, type ControlContext } from "./control.js";
import { IpcError, serveIpc, type IpcHandlers } from "./ipc.js";
import { LanListener, lanEndpoints, REMOTE_SERVICE_TYPE } from "./lan.js";
import type { AcceptLink } from "./link.js";
import { OfferBook, type PairedDevice } from "./offers.js";
import { RelayLink, type RelayState } from "./relay.js";
import { RuntimeBridge, type RuntimeLauncher } from "./runtimes.js";
import * as state from "./state.js";
import type { Device, HostIdentity, Logger, ProjectRecord, RemoteConfig, RemotePaths } from "./state.js";

export interface HostOptions {
  paths: RemotePaths;
  launcher: RuntimeLauncher;
  env?: Environment;
  home?: string;
  name?: string;
  log?: Logger;
  /** false turns Bonjour off. */
  advertise?: false | ((ad: Advertisement) => Advertiser);
  /** LAN bind address; every interface by default. */
  lanHost?: string;
  /** false keeps the host off the relay. */
  relay?: boolean;
  relayBackoff?: { baseMs: number; maxMs: number };
  offerTtlMs?: number;
  handshakeTimeoutMs?: number;
  /** false skips the control socket. */
  ipc?: boolean;
  /** Called for the control socket's `stop`; defaults to `close`. */
  onStop?: () => void;
}
export interface HostStatus {
  id: string;
  name: string;
  version: string;
  pid: number;
  relay: { url: string; state: RelayState | "off"; connected: boolean };
  lan: { port: number; addresses: string[] };
  devices: Array<Device & { connected: boolean }>;
}
export interface OfferTicket {
  offer: string;
  link: string;
  expiresAt: number;
  host: { id: string; name: string };
}

/** `oxbit remote serve`: keys, paired devices, the relay and LAN paths, and the control socket. */
export class RemoteHost implements ConnectionHost {
  readonly connections = new Set<DeviceConnection>();
  readonly name: string;
  readonly log: Logger;
  readonly handshakeTimeoutMs: number;
  readonly offers: OfferBook;
  private readonly live = new Set<DeviceConnection>();
  private readonly context: ControlContext;
  private relay?: RelayLink;
  private lan?: LanListener;
  private advertiser?: Advertiser;
  private ipc?: { close(): Promise<void> };
  private writes = Promise.resolve();
  private closed = false;

  private constructor(
    private readonly options: HostOptions,
    private identity: HostIdentity,
    private readonly config: RemoteConfig,
    private devices: Device[],
    private projects: ProjectRecord[],
    policy: PathPolicy,
  ) {
    this.name = options.name ?? localName();
    this.log = options.log ?? (() => {});
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
    this.offers = new OfferBook(options.offerTtlMs);
    this.context = {
      info: () => ({ id: this.identity.id, name: this.name, version: runtimeVersion(), platform: process.platform, home: policy.home }),
      policy,
      bridge: new RuntimeBridge(options.launcher),
      projects: () => listProjects(this.projects, options.launcher, policy),
      opened: (root) => this.recordProject(root),
    };
  }

  static async start(options: HostOptions): Promise<RemoteHost> {
    const { identity, config } = await state.ensureState(options.paths, options.env);
    const policy = await PathPolicy.create(options.home ?? os.homedir());
    const [devices, projects] = await Promise.all([state.readDevices(options.paths), state.readProjects(options.paths)]);
    const host = new RemoteHost(options, identity, config, devices, projects, policy);
    if (options.ipc !== false) host.ipc = await serveIpc(options.paths.socket, host.handlers());
    try {
      await host.startPaths();
    } catch (error) {
      await host.ipc?.close();
      throw error;
    }
    host.log(`Host ${identity.id} "${host.name}" started (version ${runtimeVersion()}, pid ${process.pid})`);
    return host;
  }

  get id() {
    return this.identity.id;
  }
  get hostKey(): KeyPair {
    return this.identity.static;
  }
  get hello(): HostHello {
    return { v: 1, id: this.identity.id, name: this.name };
  }

  private readonly accept: AcceptLink = (link) => {
    const connection = new DeviceConnection(this, link);
    this.connections.add(connection);
    return connection;
  };

  private async startPaths() {
    const { config, options, identity, log } = this;
    this.lan = await LanListener.start({ port: config.lanPort, host: options.lanHost, accept: this.accept });
    if (options.advertise !== false) {
      const ad = { id: this.id, name: this.name, version: runtimeVersion(), port: this.lan.port, service: REMOTE_SERVICE_TYPE };
      this.advertiser = options.advertise ? options.advertise(ad) : mdnsAdvertise(ad, log);
    }
    if (options.relay !== false) {
      this.relay = new RelayLink({ url: config.relay, hostId: identity.id, admission: identity.admission, accept: this.accept, log, backoff: options.relayBackoff });
      this.relay.start();
    }
    log(`Listening on the LAN at port ${this.lan.port}${this.relay ? `; relay ${config.relay}` : ""}`);
  }

  private async stopPaths() {
    this.relay?.stop();
    this.relay = undefined;
    await this.advertiser?.close();
    this.advertiser = undefined;
    await this.lan?.close();
    this.lan = undefined;
    for (const connection of this.connections) connection.close("host-stopping");
  }

  isKnown(deviceId: string) {
    return this.devices.some((device) => device.id === deviceId);
  }
  claimOffer(offerId: string) {
    return this.offers.claim(offerId);
  }
  releaseOffer(offerId: string) {
    this.offers.release(offerId);
  }

  completePairing(offerId: string, device: PairedDevice) {
    const now = Date.now();
    const known = this.devices.find((entry) => entry.id === device.id);
    if (known) Object.assign(known, { name: device.name, lastSeen: now });
    else this.devices.push({ ...device, pairedAt: now, lastSeen: now });
    this.saveDevices();
    this.offers.complete(offerId, device);
    this.log(`Paired "${device.name}" (${device.id.slice(0, 8)})`);
  }

  opened(connection: DeviceConnection) {
    this.live.add(connection);
    this.touch(connection.deviceId!);
    this.log(`"${connection.name}" connected over ${connection.link.path}`);
  }

  serve(connection: DeviceConnection) {
    return serveControl(connection.session!, connection.control!, this.context);
  }

  ended(connection: DeviceConnection, reason: string) {
    this.connections.delete(connection);
    if (this.live.delete(connection)) {
      this.touch(connection.deviceId!);
      this.log(`"${connection.name}" disconnected over ${connection.link.path} (${reason})`);
    } else if (reason !== "closed") {
      this.log(`Refused a device over ${connection.link.path}: ${reason}`);
    }
  }

  private touch(deviceId: string) {
    const device = this.devices.find((entry) => entry.id === deviceId);
    if (!device) return;
    device.lastSeen = Date.now();
    this.saveDevices();
  }

  private persist(write: () => Promise<void>) {
    this.writes = this.writes.then(write).catch((error: Error) => this.log(`Saving host state failed: ${error.message}`));
  }

  private saveDevices() {
    this.persist(() => state.writeDevices(this.options.paths, this.devices));
  }

  private recordProject(root: string) {
    this.projects = [{ path: root, lastOpened: Date.now() }, ...this.projects.filter((entry) => entry.path !== root)].slice(0, 50);
    this.persist(() => state.writeProjects(this.options.paths, this.projects));
  }

  lanAddresses(): string[] {
    if (!this.lan) return [];
    const bound = this.options.lanHost;
    return bound && !wildcardHost(bound) ? [`${bound}:${this.lan.port}`] : lanEndpoints(this.lan.port);
  }

  async createOffer(): Promise<OfferTicket> {
    const offer = await createOffer({
      admissionKey: this.identity.admission.publicKey,
      staticKey: this.identity.static.publicKey,
      name: this.name,
      relay: this.config.relay,
      lan: this.lanAddresses(),
    });
    const { expiresAt } = this.offers.add(offer);
    this.log(`Created a pairing link that expires at ${new Date(expiresAt).toISOString()}`);
    return { offer: offer.o, link: offerLink(offer), expiresAt, host: { id: this.id, name: this.name } };
  }

  status(): HostStatus {
    const connected = new Set([...this.live].map((connection) => connection.deviceId));
    return {
      id: this.id,
      name: this.name,
      version: runtimeVersion(),
      pid: process.pid,
      relay: { url: this.config.relay, state: this.relay?.state ?? "off", connected: this.relay?.state === "connected" },
      lan: { port: this.lan?.port ?? 0, addresses: this.lanAddresses() },
      devices: this.devices.map((device) => ({ ...device, connected: connected.has(device.id) })),
    };
  }

  revoke(query: string): Device {
    const match = state.matchDevice(this.devices, query);
    if ("error" in match) throw new IpcError("NOT_FOUND", match.error);
    const { device } = match;
    this.devices = this.devices.filter((entry) => entry.id !== device.id);
    this.saveDevices();
    for (const connection of this.connections) if (connection.deviceId === device.id) connection.close("revoked");
    this.log(`Revoked "${device.name}" (${device.id.slice(0, 8)})`);
    return device;
  }

  /** New keys and no devices; open sessions close with `revoked`. */
  async reset(): Promise<{ id: string }> {
    this.devices = [];
    this.offers.clear();
    for (const connection of this.connections) connection.close("revoked");
    await this.stopPaths();
    await this.writes;
    this.identity = await state.resetHost(this.options.paths);
    await this.startPaths();
    this.log(`Reset the host keys; new host id ${this.id}`);
    return { id: this.id };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.offers.clear();
    await this.stopPaths();
    await this.ipc?.close();
    await this.writes;
    this.log("Host stopped");
  }

  private handlers(): IpcHandlers {
    const stop = this.options.onStop ?? (() => void this.close());
    return {
      ping: () => ({ ok: true }),
      status: () => this.status(),
      "offer.create": () => this.createOffer(),
      "offer.wait": (params) => this.offers.wait(String(params.offer)),
      devices: () => ({ devices: this.status().devices }),
      revoke: (params) => ({ device: this.revoke(String(params.device ?? "")) }),
      reset: () => this.reset(),
      stop: () => (setImmediate(stop), {}),
    };
  }
}
