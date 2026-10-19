import { verifyHostAuth } from "./auth.js";
import { ByteBudget, DAY_COUNT_KEY, type DayCount } from "./budget.js";
import { OPEN, type DurableState, type RelaySocket } from "./cloudflare.js";
import {
  base64UrlToBytes,
  bytesToBase64Url,
  CLOSE,
  closeReason,
  CONNECTION_ID_BYTES,
  encode,
  HOST_PATH,
  NONCE_BYTES,
  parseHostMessage,
  prefixFrame,
  splitFrame,
  type Limits,
} from "./protocol.js";
import {
  attach,
  attachmentOf,
  close,
  connectionTag,
  DEVICE_TAG,
  HOST_TAG,
  SEEN_STEP_MS,
  send,
  type Attachment,
  type DeviceAttachment,
  type Entry,
  type HostAttachment,
} from "./sockets.js";

export interface RelayDeps {
  now(): number;
  randomBytes(length: number): Uint8Array;
  socketPair(): [client: RelaySocket, server: RelaySocket];
  upgrade(client: RelaySocket): Response;
  autoResponse(): unknown;
  limits: Limits;
}

/** Durable Object for one host id. Socket state lives in tags and attachments so it survives hibernation. */
export class HostRelay {
  private budget!: ByteBudget;
  /** `undefined` until read from storage after a wake. */
  private alarmAt: number | null | undefined;

  constructor(
    private readonly state: DurableState,
    private readonly deps: RelayDeps,
  ) {
    state.setWebSocketAutoResponse(deps.autoResponse());
    void state.blockConcurrencyWhile(async () => {
      const stored = await state.storage.get<DayCount>(DAY_COUNT_KEY);
      this.budget = new ByteBudget(deps.limits, stored, (count) => void state.storage.put(DAY_COUNT_KEY, count));
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const [client, server] = this.deps.socketPair();
    if (url.pathname === HOST_PATH) await this.acceptHost(server, url.searchParams.get("id") ?? "");
    else await this.acceptDevice(server);
    return this.deps.upgrade(client);
  }

  async webSocketMessage(socket: RelaySocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = attachmentOf(socket);
    if (!attachment || attachment.gone) return;
    if (attachment.role === "device") return this.onDeviceMessage(socket, attachment, message);
    if (!attachment.authenticated) {
      if (typeof message === "string") return this.authenticate(socket, attachment, message);
      return this.retire(socket, attachment, CLOSE.unauthenticated, "not authenticated");
    }
    if (typeof message === "string") return this.onControl(message);
    this.forwardToDevice(message);
  }

  async webSocketClose(socket: RelaySocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    this.release(socket);
    close(socket, 1000, "closed");
  }

  async webSocketError(socket: RelaySocket, _error: unknown): Promise<void> {
    this.release(socket);
  }

  async alarm(): Promise<void> {
    this.alarmAt = null;
    const now = this.deps.now();
    let next = Number.POSITIVE_INFINITY;
    for (const [socket, attachment] of this.live()) {
      const due = this.deadline(attachment);
      if (now < due) next = Math.min(next, due);
      else this.expire(socket, attachment);
    }
    this.budget.flush();
    if (next < Number.POSITIVE_INFINITY) await this.schedule(next);
  }

  private async acceptHost(socket: RelaySocket, hostId: string): Promise<void> {
    const openedAt = this.deps.now();
    const nonce = bytesToBase64Url(this.deps.randomBytes(NONCE_BYTES));
    this.state.acceptWebSocket(socket, [HOST_TAG]);
    attach(socket, { role: "host", hostId, nonce, openedAt, authenticated: false, gone: false });
    send(socket, encode({ t: "challenge", nonce }));
    await this.schedule(openedAt + this.deps.limits.authMs);
  }

  private async acceptDevice(socket: RelaySocket): Promise<void> {
    const openedAt = this.deps.now();
    const host = this.host();
    const refusal = host ? this.deviceRefusal(openedAt) : ([CLOSE.hostOffline, "host offline"] as const);
    if (!host || refusal) {
      socket.accept?.();
      if (refusal) close(socket, ...refusal);
      return;
    }
    const id = bytesToBase64Url(this.deps.randomBytes(CONNECTION_ID_BYTES));
    this.state.acceptWebSocket(socket, [DEVICE_TAG, connectionTag(id)]);
    attach(socket, { role: "device", id, openedAt, seenAt: openedAt, established: false, gone: false });
    send(host[0], encode({ t: "open", c: id }));
    await this.schedule(openedAt + this.deps.limits.handshakeMs);
  }

  private deviceRefusal(now: number): readonly [number, string] | null {
    const devices = this.devices();
    const established = devices.filter(([, attachment]) => attachment.established).length;
    if (devices.length - established >= this.deps.limits.handshaking) return [CLOSE.limited, "too many handshakes"];
    if (established >= this.deps.limits.established) return [CLOSE.limited, "too many devices"];
    if (this.budget.exhausted(now)) return [CLOSE.limited, "byte limit"];
    return null;
  }

  private async authenticate(socket: RelaySocket, attachment: HostAttachment, text: string): Promise<void> {
    const message = parseHostMessage(text);
    const inTime = this.deps.now() < attachment.openedAt + this.deps.limits.authMs;
    const valid =
      message?.t === "auth" &&
      inTime &&
      (await verifyHostAuth(attachment.hostId, attachment.nonce, message.key, message.sig));
    const current = attachmentOf(socket);
    if (current?.role !== "host" || current.gone || current.authenticated || socket.readyState !== OPEN) return;
    if (!valid) return this.retire(socket, current, CLOSE.unauthenticated, inTime ? "auth failed" : "auth timeout");
    for (const [other, otherAttachment] of this.hosts()) {
      if (other !== socket && otherAttachment.authenticated) this.retire(other, otherAttachment, CLOSE.replaced, "replaced");
    }
    this.closeDevices();
    attach(socket, { ...current, authenticated: true });
    send(socket, encode({ t: "ready" }));
  }

  private async onControl(text: string): Promise<void> {
    const message = parseHostMessage(text);
    if (!message || message.t === "auth") return;
    const entry = this.device(message.c);
    if (!entry) return;
    const [socket, attachment] = entry;
    if (message.t === "close") return this.drop(socket, attachment, CLOSE.dropped, closeReason(message.reason));
    if (attachment.established) return;
    const now = this.deps.now();
    if (now >= this.deadline(attachment)) return this.expire(socket, attachment);
    const established = this.devices().filter(([, device]) => device.established).length;
    if (established >= this.deps.limits.established) return this.drop(socket, attachment, CLOSE.limited, "too many devices");
    attach(socket, { ...attachment, established: true, seenAt: now });
    await this.schedule(now + this.deps.limits.idleMs);
  }

  private onDeviceMessage(socket: RelaySocket, attachment: DeviceAttachment, message: string | ArrayBuffer): void {
    if (typeof message === "string") return;
    const host = this.host();
    if (!host) return this.retire(socket, attachment, CLOSE.hostOffline, "host offline");
    if (this.admit(socket, attachment, message.byteLength)) send(host[0], prefixFrame(base64UrlToBytes(attachment.id)!, message));
  }

  private forwardToDevice(frame: ArrayBuffer): void {
    const split = splitFrame(frame);
    const entry = split && this.device(split.id);
    if (!split || !entry) return;
    const [socket, attachment] = entry;
    if (this.admit(socket, attachment, split.payload.byteLength)) send(socket, split.payload);
  }

  /** Applies the deadline, frame and byte limits to one payload. Closes the device and returns false when one fails. */
  private admit(socket: RelaySocket, attachment: DeviceAttachment, bytes: number): boolean {
    const now = this.deps.now();
    if (now >= this.deadline(attachment)) this.expire(socket, attachment);
    else if (bytes > this.deps.limits.frameBytes) this.drop(socket, attachment, CLOSE.tooLarge, "frame too large");
    else if (!this.budget.take(bytes, now)) this.drop(socket, attachment, CLOSE.limited, "byte limit");
    else {
      if (now - attachment.seenAt >= SEEN_STEP_MS) attach(socket, { ...attachment, seenAt: now });
      return true;
    }
    return false;
  }

  private deadline(attachment: Attachment): number {
    const { limits } = this.deps;
    if (attachment.role === "host") {
      return attachment.authenticated ? Number.POSITIVE_INFINITY : attachment.openedAt + limits.authMs;
    }
    return attachment.established ? attachment.seenAt + limits.idleMs : attachment.openedAt + limits.handshakeMs;
  }

  private expire(socket: RelaySocket, attachment: Attachment): void {
    if (attachment.role === "host") this.retire(socket, attachment, CLOSE.unauthenticated, "auth timeout");
    else this.drop(socket, attachment, CLOSE.timeout, attachment.established ? "idle" : "handshake timeout");
  }

  /** Closes a device and tells the host. */
  private drop(socket: RelaySocket, attachment: DeviceAttachment, code: number, reason: string): void {
    this.retire(socket, attachment, code, reason);
    const host = this.host();
    if (host) send(host[0], encode({ t: "closed", c: attachment.id }));
  }

  /** Marks a socket gone before closing it, so its later `webSocketClose` does nothing. */
  private retire(socket: RelaySocket, attachment: Attachment, code: number, reason: string): void {
    attach(socket, { ...attachment, gone: true });
    close(socket, code, reason);
  }

  private closeDevices(): void {
    for (const [socket, attachment] of this.devices()) this.retire(socket, attachment, CLOSE.hostOffline, "host offline");
  }

  private release(socket: RelaySocket): void {
    const attachment = attachmentOf(socket);
    if (!attachment || attachment.gone) return;
    attach(socket, { ...attachment, gone: true });
    if (attachment.role === "host") {
      if (attachment.authenticated) this.closeDevices();
      return;
    }
    const host = this.host();
    if (host) send(host[0], encode({ t: "closed", c: attachment.id }));
  }

  private async schedule(time: number): Promise<void> {
    if (this.alarmAt === undefined) {
      const stored = await this.state.storage.getAlarm();
      if (this.alarmAt === undefined) this.alarmAt = stored;
    }
    if (this.alarmAt !== null && this.alarmAt <= time) return;
    this.alarmAt = time;
    await this.state.storage.setAlarm(time);
  }

  private live(tag?: string): Entry<Attachment>[] {
    const entries: Entry<Attachment>[] = [];
    for (const socket of this.state.getWebSockets(tag)) {
      const attachment = attachmentOf(socket);
      if (attachment && !attachment.gone && socket.readyState === OPEN) entries.push([socket, attachment]);
    }
    return entries;
  }

  private hosts(): Entry<HostAttachment>[] {
    return this.live(HOST_TAG).filter((entry): entry is Entry<HostAttachment> => entry[1].role === "host");
  }

  private host(): Entry<HostAttachment> | null {
    return this.hosts().find(([, attachment]) => attachment.authenticated) ?? null;
  }

  private devices(): Entry<DeviceAttachment>[] {
    return this.live(DEVICE_TAG).filter((entry): entry is Entry<DeviceAttachment> => entry[1].role === "device");
  }

  private device(id: string): Entry<DeviceAttachment> | null {
    const entry = this.live(connectionTag(id))[0];
    return entry?.[1].role === "device" ? (entry as Entry<DeviceAttachment>) : null;
  }
}
