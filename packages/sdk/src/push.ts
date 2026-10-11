import type { AgentActivityUpdate } from "./agent-acp.js";

/** Relay that holds the APNs key. Runtimes override it with `OXBIT_PUSH_RELAY`. */
export const PUSH_RELAY_URL = "https://oxbit-push.ryanyannelli.workers.dev";
/** Shared by local notifications and pushes, so a late local notification replaces the push. */
export const PUSH_COLLAPSE_ID = "oxbit-agent-acp";

export type PushEnvironment = "production" | "development";
/** `alert` registers an APNs device token; `liveactivity` registers a Live Activity push token. */
export type PushTokenKind = "alert" | "liveactivity";

/** `POST {relay}/v1/devices`, sent by the iOS app. */
export interface PushDeviceRequest {
  /** Hex APNs token. */
  token: string;
  environment: PushEnvironment;
  kind: PushTokenKind;
}
/** The handle seals the token; only the relay can open it. */
export interface PushDeviceResponse {
  handle: string;
}

/** Live Activity content in the shape of the widget's `ContentState`. */
export interface PushActivityState {
  status: AgentActivityUpdate["status"];
  title: string;
  detail: string;
  pending: number;
  /** Seconds since the Unix epoch; `ContentState` decodes this key explicitly. */
  startedAt?: number;
}
/** `POST {relay}/v1/push`, sent by the runtime. Exactly one of `alert` and `activity`. */
export interface PushRequest {
  handle: string;
  alert?: { title: string; body: string };
  activity?: {
    event: "update" | "end";
    state: PushActivityState;
    /** Seconds since the Unix epoch. */
    staleDate?: number;
    /** Seconds since the Unix epoch; `end` only. */
    dismissalDate?: number;
  };
}
/** `gone`: APNs reported the token unregistered (HTTP 410); drop the handle. */
export interface PushResponse {
  sent: boolean;
  gone?: boolean;
  reason?: string;
}

/** Runtime RPC `push.register`. Replaces the device's earlier handles. */
export interface PushRegisterParams {
  /** Random ID the app keeps across launches. */
  deviceId: string;
  alert?: string;
  liveActivity?: string;
}
/** Runtime RPC `push.state`. The runtime pushes only to devices that are inactive or disconnected. */
export interface PushStateParams {
  deviceId: string;
  active: boolean;
  /** The app's current activity, sent with `active: false` before iOS suspends it. */
  activity?: AgentActivityUpdate | null;
}
/** Runtime RPC `push.unregister`. */
export interface PushUnregisterParams {
  deviceId: string;
}
