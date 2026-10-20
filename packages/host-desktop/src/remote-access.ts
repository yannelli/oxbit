import type { RemoteAccess, RemoteAccessOffer, RemoteAccessPairing, RemoteAccessStatus } from "@oxbit/workbench";

type Line = Record<string, unknown>;
export type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
export type Listen = <T>(event: string, handler: (event: { payload: T }) => void) => Promise<() => void>;

const offerOf = (line: Line): RemoteAccessOffer | undefined =>
  typeof line.link === "string" && typeof line.expiresAt === "number"
    ? { link: line.link, expiresAt: line.expiresAt, host: line.host as RemoteAccessOffer["host"] }
    : undefined;

/** Runs the bundled `oxbit remote <action> --json` through the desktop_remote_access command. */
export function desktopRemoteAccess(invoke: Invoke, listen: Listen): RemoteAccess {
  const run = (action: string, args: Line = {}) => invoke<Line[]>("desktop_remote_access", { action, ...args });
  return {
    async status() {
      const [status] = await run("status");
      if (!status) throw new Error("Remote access did not report a status");
      return status as unknown as RemoteAccessStatus;
    },
    async enable() {
      await run("enable");
    },
    async disable() {
      await run("disable");
    },
    async revoke(deviceId) {
      await run("revoke", { device: deviceId });
    },
    async pair(onOffer, signal) {
      signal?.throwIfAborted();
      const request = crypto.randomUUID();
      let offered = false;
      const offer = (line: Line) => {
        const value = offerOf(line);
        if (!value || offered) return;
        offered = true;
        onOffer(value);
      };
      const unlisten = await listen<{ request: string; line: Line }>("desktop-remote-access", ({ payload }) => {
        if (payload.request === request) offer(payload.line);
      });
      const cancel = () => void run("cancel").catch(() => undefined);
      signal?.addEventListener("abort", cancel, { once: true });
      try {
        const lines = await run("pair", { request });
        signal?.throwIfAborted();
        lines.forEach(offer);
        const result = lines.find((line) => "paired" in line || line.expired === true);
        if (!result) throw new Error("Pairing stopped before a device paired");
        return ("paired" in result ? { paired: result.paired } : { expired: true }) as RemoteAccessPairing;
      } finally {
        signal?.removeEventListener("abort", cancel);
        unlisten();
      }
    },
  };
}
