import { ControlChannel, InitiatorHandshake, TunnelSocket, base64urlDecode, type Offer, type TunnelSession } from "@oxbit/sdk/tunnel";
import { RuntimeClient } from "./index.js";
import { RemoteError, closeError, dial, dialTargets, remoteError, type Dialed } from "./remote-dial.js";
import { remoteRuntimeUrl, type HostInfo, type HostListing, type HostOpened, type HostProject, type PairedHost, type RemoteHostOptions, type RemoteHostStatus } from "./remote-records.js";

const RETRY_MS = [1000, 3000, 10_000, 30_000, 60_000];
const HEARTBEAT_MS = 4 * 60_000;
const PROBE_MS = 5000;
const OPEN_TIMEOUT_MS = 60_000;

/** One paired computer: its tunnel, presence, and control requests. Reconnects with backoff until disposed. */
export class RemoteHost {
  private live?: { session: TunnelSession; control: ControlChannel };
  private last?: TunnelSession;
  private connecting?: Promise<void>;
  private value: RemoteHostStatus;
  private readonly listeners = new Set<() => void>();
  private retries = 0;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private disposed = false;

  constructor(
    private host: PairedHost,
    private readonly options: RemoteHostOptions,
    private offer?: Offer,
  ) {
    this.value = { state: "idle", lastSeen: host.lastSeen };
  }

  /** Pairs with IKpsk2 using the offer; later connections use IK. */
  static async pair(offer: Offer, options: RemoteHostOptions): Promise<RemoteHost> {
    const record: PairedHost = { id: offer.h, name: offer.n, key: offer.x, relay: offer.r, pairedAt: Date.now() };
    if (offer.l) record.lan = offer.l;
    const host = new RemoteHost(record, options, offer);
    try {
      await host.connect();
      return host;
    } catch (error) {
      host.dispose();
      throw error;
    }
  }

  get id(): string {
    return this.host.id;
  }
  get record(): PairedHost {
    return this.host;
  }
  status = (): RemoteHostStatus => this.value;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  connect(): Promise<void> {
    if (this.disposed) return Promise.reject(remoteError("removed", this.host.name));
    if (this.live) return Promise.resolve();
    return (this.connecting ??= this.dial().finally(() => (this.connecting = undefined)));
  }

  /** Skips the retry delay and checks a live tunnel, for a return to the foreground. */
  reconnect(): Promise<void> {
    this.retries = 0;
    clearTimeout(this.retryTimer);
    const live = this.live;
    if (!live) return this.connect();
    return live.control.request("host.info", {}, PROBE_MS).then(() => undefined, () => {
      live.session.close("The host did not answer");
      return this.connect();
    });
  }

  info() {
    return this.request<HostInfo>("host.info");
  }
  list(path: string) {
    return this.request<HostListing>("host.list", { path });
  }
  projects() {
    return this.request<{ projects: HostProject[] }>("host.projects");
  }
  open(path: string) {
    return this.request<HostOpened>("host.open", { path }, OPEN_TIMEOUT_MS);
  }
  close(stream: number) {
    return this.request<Record<string, never>>("host.close", { stream });
  }

  /** Opens `path` and returns a connected client. Each reconnect asks the host for a new stream and token. */
  async connectRuntime(path: string): Promise<RuntimeClient> {
    let first: { opened: HostOpened; session: TunnelSession } | undefined = { opened: await this.open(path), session: (this.live?.session ?? this.last)! };
    let failure: unknown;
    const client: RuntimeClient = new RuntimeClient(remoteRuntimeUrl(this.id), "default", {
      token: first.opened.token,
      persistToken: false,
      socket: () => {
        const live = this.live;
        return new TunnelSocket(live?.session ?? this.last!, async () => {
          if (!live) throw remoteError("offline", this.host.name);
          try {
            const opened = first?.session === live.session ? first.opened : await live.control.request<HostOpened>("host.open", { path }, OPEN_TIMEOUT_MS);
            first = undefined;
            client.useToken(opened.token);
            return opened.stream;
          } catch (error) {
            failure = error;
            throw error;
          }
        });
      },
    });
    const off = this.subscribe(() => {
      if (this.value.state === "online" && client.autoReconnect && !client.connected) void client.reconnect().catch(() => undefined);
    });
    const dispose = client.dispose.bind(client);
    client.dispose = () => {
      off();
      dispose();
    };
    try {
      await client.connect();
      return client;
    } catch (error) {
      client.dispose();
      throw failure ?? error;
    }
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.retryTimer);
    this.live?.session.close("Removed");
    this.listeners.clear();
  }

  private async request<T>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    await this.connect();
    if (!this.live) throw remoteError("unreachable", this.host.name);
    return this.live.control.request<T>(method, params, timeoutMs);
  }

  private async dial(): Promise<void> {
    clearTimeout(this.retryTimer);
    const offer = this.offer;
    const { deviceKey, deviceName: name } = this.options;
    this.set({ state: "connecting", error: undefined });
    let dialed: Dialed | undefined;
    try {
      dialed = await dial(
        dialTargets(this.host, this.options.bonjour?.(this.host.id)),
        () => InitiatorHandshake.start(offer ? { deviceKey, name, offer } : { deviceKey, name, hostKey: base64urlDecode(this.host.key) }),
        this.options.webSocket ?? ((url) => new WebSocket(url)),
        this.host.name,
      );
      if (dialed.host.id !== this.host.id) throw remoteError("mismatch", this.host.name);
      const { session } = dialed;
      const control = new ControlChannel(session);
      // The host keeps an IKpsk2 pairing once the device's first transport message decrypts.
      if (offer) await control.request("host.info");
      if (this.disposed || session.closed) throw remoteError("unreachable", this.host.name);
      this.offer = undefined;
      this.live = { session, control };
      this.last = session;
      this.retries = 0;
      session.on("close", () => this.dropped(session, dialed!));
      this.remember({ name: dialed.host.name, lastSeen: Date.now() });
      this.set({ state: "online", via: dialed.via, error: undefined });
      this.beat(control, session);
    } catch (error) {
      dialed?.session.close("Connection failed");
      const closed = dialed?.closed();
      const failure = error instanceof RemoteError ? error
        : closed && closed.code >= 4000 ? closeError(closed.code, closed.reason, this.host.name) : remoteError("handshake", this.host.name);
      const offline = failure.code === "offline" || failure.code === "unreachable";
      this.set({ state: offline ? "offline" : "failed", via: undefined, error: failure.message });
      if (!offer && (offline || failure.code === "limited")) this.schedule();
      throw failure;
    }
  }

  private dropped(session: TunnelSession, dialed: Dialed): void {
    if (this.live?.session !== session) return;
    this.live.control.dispose();
    this.live = undefined;
    clearInterval(this.heartbeat);
    this.remember({ lastSeen: Date.now() });
    if (this.disposed) return this.set({ state: "idle", via: undefined });
    const closed = dialed.closed();
    const failure = closed && closed.code >= 4000 ? closeError(closed.code, closed.reason, this.host.name) : undefined;
    if (failure && !["offline", "unreachable", "limited"].includes(failure.code))
      return this.set({ state: "failed", via: undefined, error: failure.message });
    this.set({ state: failure?.code === "offline" ? "offline" : "connecting", via: undefined, error: failure?.message });
    this.schedule();
  }

  private schedule(): void {
    clearTimeout(this.retryTimer);
    if (this.disposed) return;
    const delays = this.options.retryMs ?? RETRY_MS;
    const delay = delays[Math.min(this.retries++, delays.length - 1)];
    this.retryTimer = setTimeout(() => void this.connect().catch(() => undefined), delay);
  }

  private beat(control: ControlChannel, session: TunnelSession): void {
    clearInterval(this.heartbeat);
    const every = this.options.heartbeatMs ?? HEARTBEAT_MS;
    if (every > 0)
      this.heartbeat = setInterval(() => void control.request("host.info", {}, 20_000).catch(() => session.close("The host did not answer")), every);
  }

  private remember(patch: Partial<PairedHost>): void {
    this.host = { ...this.host, ...patch };
    this.value = { ...this.value, lastSeen: this.host.lastSeen };
    this.options.onRecord?.(this.host);
  }

  private set(patch: Partial<RemoteHostStatus>): void {
    this.value = { ...this.value, ...patch };
    for (const listener of [...this.listeners]) listener();
  }
}
