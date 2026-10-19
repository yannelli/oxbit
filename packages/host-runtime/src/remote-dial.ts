import { TunnelSession, type HostHello, type InitiatorHandshake } from "@oxbit/sdk/tunnel";

/** The WebSocket members dialing uses; tests pass an in-memory socket. */
export type DialSocket = Pick<WebSocket, "binaryType" | "send" | "close" | "onopen" | "onmessage" | "onerror" | "onclose">;
export type WebSocketFactory = (url: string) => DialSocket;

export type RemotePath = "lan" | "relay";
export interface DialTarget {
  url: string;
  via: RemotePath;
  timeoutMs: number;
}
export interface Dialed {
  session: TunnelSession;
  host: HostHello;
  via: RemotePath;
  /** The WebSocket close code and reason, once the socket closed. */
  closed(): { code: number; reason: string } | undefined;
}

export const LAN_TIMEOUT_MS = 2500;
export const RELAY_TIMEOUT_MS = 12_000;

export type RemoteErrorCode = "offline" | "unreachable" | "expired" | "removed" | "handshake" | "limited" | "invalid-link" | "mismatch";

export class RemoteError extends Error {
  constructor(
    readonly code: RemoteErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RemoteError";
  }
}

const PAIR_AGAIN = "Run oxbit remote pair on your computer for a new one.";

export function remoteError(code: RemoteErrorCode, name = "The computer"): RemoteError {
  const messages: Record<RemoteErrorCode, string> = {
    offline: `${name} is offline.`,
    unreachable: `Can't reach ${name}. Check this device's internet connection.`,
    expired: `This pairing link expired. ${PAIR_AGAIN}`,
    removed: `${name} no longer accepts this device. Open a new pairing link from oxbit remote pair.`,
    handshake: `The secure connection to ${name} failed. Open a new pairing link from oxbit remote pair.`,
    limited: `${name} has too many connections right now. Try again in a minute.`,
    "invalid-link": `This pairing link is not valid. ${PAIR_AGAIN}`,
    mismatch: `A different computer answered for ${name}. Open a new pairing link from oxbit remote pair.`,
  };
  return new RemoteError(code, messages[code]);
}

/** Maps a relay or host close code to the error a device shows; codes below 4000 mean the path failed. */
export function closeError(code: number, reason: string, name?: string): RemoteError {
  if (code === 4404) return remoteError("offline", name);
  if (code === 4429) return remoteError("limited", name);
  if (code !== 4403) return remoteError("unreachable", name);
  if (reason === "offer-expired") return remoteError("expired", name);
  return remoteError(reason === "bad-handshake" ? "handshake" : "removed", name);
}

/** Bonjour addresses first, then the offer's LAN addresses, then the relay. */
export function dialTargets(host: { id: string; relay: string; lan?: string[] }, bonjour: string[] = []): DialTarget[] {
  const lan = [...new Set([...bonjour, ...(host.lan ?? [])])];
  return [
    ...lan.map((address): DialTarget => ({ url: `ws://${address}/v1/connect`, via: "lan", timeoutMs: LAN_TIMEOUT_MS })),
    { url: `${host.relay.replace(/\/+$/, "")}/v1/connect?id=${encodeURIComponent(host.id)}`, via: "relay", timeoutMs: RELAY_TIMEOUT_MS },
  ];
}

/** Tries each target in order. A LAN failure moves on; the relay's answer is final unless it only failed to connect. */
export async function dial(
  targets: DialTarget[],
  start: () => Promise<InitiatorHandshake>,
  open: WebSocketFactory,
  name?: string,
): Promise<Dialed> {
  let failure: RemoteError | undefined;
  for (const target of targets) {
    try {
      return await attempt(target, start, open, name);
    } catch (error) {
      const reason = error instanceof RemoteError ? error : remoteError("handshake", name);
      if (!failure || failure.code === "unreachable" || (target.via === "relay" && reason.code !== "unreachable")) failure = reason;
    }
  }
  throw failure ?? remoteError("unreachable", name);
}

function attempt(target: DialTarget, start: () => Promise<InitiatorHandshake>, open: WebSocketFactory, name?: string): Promise<Dialed> {
  return new Promise<Dialed>((resolve, reject) => {
    let socket: DialSocket;
    try {
      socket = open(target.url);
    } catch {
      reject(remoteError("unreachable", name));
      return;
    }
    socket.binaryType = "arraybuffer";
    let handshake: Promise<InitiatorHandshake> | undefined;
    let session: TunnelSession | undefined;
    let replied = false;
    let closed: { code: number; reason: string } | undefined;
    const early: ArrayBuffer[] = [];
    const fail = (error: RemoteError) => {
      clearTimeout(timer);
      reject(error);
      socket.close();
    };
    const timer = setTimeout(() => fail(remoteError("unreachable", name)), target.timeoutMs);
    socket.onopen = () => {
      handshake = start();
      handshake.then((initiator) => socket.send(initiator.message), () => fail(remoteError("handshake", name)));
    };
    socket.onmessage = (event: MessageEvent) => {
      if (!(event.data instanceof ArrayBuffer)) return;
      if (session) return void session.receive(event.data);
      if (replied || !handshake) return void early.push(event.data);
      replied = true;
      handshake.then((initiator) => initiator.finish(new Uint8Array(event.data))).then(({ ciphers, host }) => {
        clearTimeout(timer);
        session = new TunnelSession(ciphers, { send: (bytes) => socket.send(bytes), close: () => socket.close() });
        for (const data of early.splice(0)) void session.receive(data);
        resolve({ session, host, via: target.via, closed: () => closed });
        if (closed) session.close(`Socket closed with ${closed.code}`);
      }, () => fail(remoteError("handshake", name)));
    };
    socket.onerror = () => undefined;
    socket.onclose = (event: CloseEvent) => {
      closed = { code: event.code, reason: event.reason };
      if (session) session.close(`Socket closed with ${event.code}`);
      else if (!replied) fail(closeError(event.code, event.reason, name));
    };
  });
}
