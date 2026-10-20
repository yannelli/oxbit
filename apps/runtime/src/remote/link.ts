/** One device socket, on the LAN listener or multiplexed over the relay. */
export interface DeviceLink {
  readonly path: "lan" | "relay";
  send(bytes: Uint8Array): void;
  /** Drops the device: LAN closes with 4403, the relay receives `close`. */
  close(reason: string): void;
  /** The first transport message decrypted. */
  established(): void;
}
export interface LinkHandler {
  receive(bytes: Uint8Array): void;
  /** The device socket closed. */
  closed(): void;
}
export type AcceptLink = (link: DeviceLink) => LinkHandler;

export const toBytes = (data: Buffer | ArrayBuffer | Buffer[]): Uint8Array =>
  Array.isArray(data) ? new Uint8Array(Buffer.concat(data)) : new Uint8Array(data);
