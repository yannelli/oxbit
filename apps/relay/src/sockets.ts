import type { RelaySocket } from "./cloudflare.js";

export interface HostAttachment {
  role: "host";
  hostId: string;
  nonce: string;
  openedAt: number;
  authenticated: boolean;
  gone: boolean;
}

export interface DeviceAttachment {
  role: "device";
  id: string;
  openedAt: number;
  /** Last binary frame, in steps of `SEEN_STEP_MS` to limit attachment writes. */
  seenAt: number;
  established: boolean;
  gone: boolean;
}

export type Attachment = HostAttachment | DeviceAttachment;
export type Entry<T extends Attachment> = [socket: RelaySocket, attachment: T];

export const HOST_TAG = "host";
export const DEVICE_TAG = "device";
export const SEEN_STEP_MS = 1000;

export function connectionTag(id: string): string {
  return `c:${id}`;
}

export function attachmentOf(socket: RelaySocket): Attachment | null {
  return (socket.deserializeAttachment() as Attachment | null) ?? null;
}

export function attach(socket: RelaySocket, attachment: Attachment): void {
  try {
    socket.serializeAttachment(attachment);
  } catch {
    // The socket closed; nothing reads its attachment again.
  }
}

export function send(socket: RelaySocket, data: string | ArrayBuffer | Uint8Array<ArrayBuffer>): void {
  try {
    socket.send(data);
  } catch {
    // The peer is closing; its close handler cleans up.
  }
}

export function close(socket: RelaySocket, code: number, reason: string): void {
  try {
    socket.close(code, reason);
  } catch {
    // Already closed.
  }
}
