import { ControlChannel, ResponderHandshake, TunnelSession, type HostHello, type KeyPair } from "@oxbit/sdk/tunnel";
import type { DeviceLink, LinkHandler } from "./link.js";
import type { PairedDevice } from "./offers.js";
import type { Logger } from "./state.js";

export const HANDSHAKE_TIMEOUT_MS = 10_000;

/** What a device connection needs from the host. */
export interface ConnectionHost {
  readonly hostKey: KeyPair;
  readonly hello: HostHello;
  readonly handshakeTimeoutMs: number;
  readonly log: Logger;
  isKnown(deviceId: string): boolean;
  claimOffer(offerId: string): Uint8Array | undefined;
  releaseOffer(offerId: string): void;
  /** Registers the device and deletes the offer. */
  completePairing(offerId: string, device: PairedDevice): void;
  /** The connection decrypted its first transport message. */
  opened(connection: DeviceConnection): void;
  /** Serves the control stream; returns a cleanup function. */
  serve(connection: DeviceConnection): () => void;
  ended(connection: DeviceConnection, reason: string): void;
}

type State = "hello" | "handshake" | "pending" | "open" | "closed";

export const deviceName = (name: string) =>
  name.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 64) || "Device";

/** One device on one path: responder handshake, then a tunnel session with the control stream. */
export class DeviceConnection implements LinkHandler {
  deviceId?: string;
  name = "Device";
  session?: TunnelSession;
  control?: ControlChannel;
  private state: State = "hello";
  private chain = Promise.resolve();
  private offerId?: string;
  private closing?: string;
  private stopServing?: () => void;
  private readonly deadline: ReturnType<typeof setTimeout>;

  constructor(
    private readonly host: ConnectionHost,
    readonly link: DeviceLink,
  ) {
    this.deadline = setTimeout(() => this.close("bad-handshake"), host.handshakeTimeoutMs);
    this.deadline.unref();
  }

  get open() {
    return this.state === "open";
  }

  receive(bytes: Uint8Array): void {
    this.chain = this.chain
      .then(() => this.step(bytes))
      .catch((error: Error) => {
        this.host.log(`Device connection over ${this.link.path} failed: ${error.message}`);
        this.close("bad-handshake");
      });
  }

  closed(): void {
    this.close("closed");
  }

  close(reason: string): void {
    if (this.state === "closed" || this.closing) return;
    this.closing = reason;
    if (this.session && !this.session.closed) this.session.close(reason);
    else this.finish(reason);
  }

  private async step(bytes: Uint8Array) {
    if (this.state === "open") return void this.session!.receive(bytes);
    if (this.state === "pending") {
      await this.session!.receive(bytes);
      if (!this.session!.closed) this.established();
      return;
    }
    if (this.state !== "hello") return;
    this.state = "handshake";
    let handshake: ResponderHandshake;
    try {
      handshake = await ResponderHandshake.accept(bytes, { hostKey: this.host.hostKey });
    } catch {
      return this.close("bad-handshake");
    }
    this.deviceId = handshake.deviceId;
    this.name = deviceName(handshake.device.name);
    let psk: Uint8Array | undefined;
    if (handshake.pattern === "IK") {
      if (!this.host.isKnown(this.deviceId)) return this.close("unknown-device");
    } else {
      psk = this.host.claimOffer(handshake.device.offer!);
      if (!psk) return this.close("offer-expired");
      this.offerId = handshake.device.offer;
    }
    const { message, ciphers } = await handshake.reply(this.host.hello, psk);
    if (this.closing) return;
    this.link.send(message);
    const session = new TunnelSession(ciphers, {
      send: (data) => this.link.send(data),
      close: (reason) => this.finish(this.closing ?? (this.state === "open" ? reason : "bad-handshake")),
    });
    this.session = session;
    session.on("error", (error) => this.host.log(`Tunnel error from "${this.name}": ${error.message}`));
    // Registered ahead of the control channel so the device is paired before its first request runs.
    const first = [session.on("message", () => this.established()), session.on("streamClosed", () => this.established())];
    session.on("close", () => first.forEach((off) => off()));
    this.control = new ControlChannel(session);
    this.stopServing = this.host.serve(this);
    this.state = "pending";
  }

  private established() {
    if (this.state !== "pending") return;
    this.state = "open";
    clearTimeout(this.deadline);
    const device = { id: this.deviceId!, name: this.name };
    if (this.offerId) {
      this.host.completePairing(this.offerId, device);
      this.offerId = undefined;
    } else if (!this.host.isKnown(device.id)) {
      return this.close("revoked");
    }
    this.link.established();
    this.host.opened(this);
  }

  private finish(reason: string) {
    if (this.state === "closed") return;
    this.state = "closed";
    clearTimeout(this.deadline);
    if (this.offerId) this.host.releaseOffer(this.offerId);
    this.offerId = undefined;
    this.stopServing?.();
    this.control?.dispose();
    this.link.close(reason);
    this.host.ended(this, reason);
  }
}
