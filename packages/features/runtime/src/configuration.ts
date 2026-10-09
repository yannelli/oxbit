import type { Setting } from "@oxbit/sdk";

export const KEEP_ALIVE_SETTING = "runtime.keepAlive";
export const AUTO_RECONNECT_SETTING = "runtime.autoReconnect";

const keepAliveDurations = {
  "75s": 75_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "8h": 8 * 60 * 60_000,
  untilStopped: 0,
} as const;
export type KeepAlive = keyof typeof keepAliveDurations;
export const keepAliveOptions = Object.keys(keepAliveDurations) as KeepAlive[];

/** Milliseconds for the launch frame; 0 runs until stopped. Unknown values use the default. */
export function keepAliveMs(value: unknown): number {
  return keepAliveDurations[(value as KeepAlive) in keepAliveDurations ? (value as KeepAlive) : "75s"];
}

export const runtimeConfiguration: Setting[] = [
  {
    id: KEEP_ALIVE_SETTING,
    title: "Keep Runtime Alive",
    description:
      "How long a runtime Oxbit started keeps running after the last client disconnects or its connection heartbeats stop. Terminals and tasks continue while it runs.",
    type: "string",
    category: "Runtime",
    default: "75s",
    enum: keepAliveOptions,
  },
  {
    id: AUTO_RECONNECT_SETTING,
    title: "Reconnect Automatically",
    description:
      "Reconnect to the runtime after the connection drops, including when the iOS app returns to the foreground.",
    type: "boolean",
    category: "Runtime",
    default: true,
  },
];
