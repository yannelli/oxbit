import {
  PUSH_RELAY_URL,
  type AgentActivityUpdate,
  type Disposable,
  type PushDeviceRequest,
  type PushDeviceResponse,
  type PushEnvironment,
  type PushRegisterParams,
  type PushStateParams,
  type PushTokenKind,
  type RpcClient,
} from "@oxbit/sdk";
import { native } from "./native.js";
import { notificationPermission, onNotificationGrant } from "./notifications.js";
import { SESSION_SCOPE } from "./persistence.js";

/** App storage key for the random device ID that runtimes key push registrations by. */
export const PUSH_DEVICE_KEY = "push-device";
/** App storage key for the relay handle of the latest token of each kind. */
export const PUSH_HANDLES_KEY = "push-handles";

interface CachedHandle {
  token: string;
  environment: PushEnvironment;
  handle: string;
}
type HandleCache = Partial<Record<PushTokenKind, CachedHandle>>;

interface Attachment {
  runtime: RpcClient;
  activity: () => AgentActivityUpdate | null;
  /** False from a `METHOD_NOT_FOUND` answer to `push.*` until the next connection. */
  supported: boolean;
  registered: boolean;
}

/** Registers APNs and Live Activity tokens with the push relay and gives the handles to each attached runtime. */
export class IosPush {
  private readonly sessions = new Set<Attachment>();
  private readonly handles: { alert?: string; liveActivity?: string } = {};
  private environment?: PushEnvironment;
  private device?: Promise<string>;
  private cache?: Promise<HandleCache>;
  private enabling?: Promise<void>;
  private watching?: Promise<unknown>;

  constructor(private readonly relay = PUSH_RELAY_URL) {}

  /** With notification permission granted, registers for remote notifications and registers every attached runtime. */
  enable(): Promise<void> {
    this.enabling ??= this.registerDevice().finally(() => {
      this.enabling = undefined;
    });
    return this.enabling;
  }

  /** Registers the device with `runtime` and reports foreground state to it until disposed. */
  attach(runtime: RpcClient, activity: () => AgentActivityUpdate | null): Disposable {
    const session: Attachment = { runtime, activity, supported: true, registered: false };
    this.sessions.add(session);
    const offConnection = runtime.subscribe("connection.change", (change: { state?: string }) => {
      session.registered = false;
      if (change.state !== "connected") return;
      session.supported = true;
      void this.register(session);
    });
    const offGrant = onNotificationGrant(() => void this.enable());
    const visibility = () => void this.state(session);
    globalThis.document?.addEventListener("visibilitychange", visibility);
    void this.enable();
    return {
      dispose: () => {
        this.sessions.delete(session);
        offConnection();
        offGrant();
        globalThis.document?.removeEventListener("visibilitychange", visibility);
      },
    };
  }

  private async registerDevice() {
    try {
      if ((await notificationPermission()) !== "granted") return;
      const { token, environment } = await native.registerRemoteNotifications();
      this.environment = environment;
      this.handles.alert = await this.handle("alert", token, environment);
      this.watchActivityTokens();
      await this.registerAll();
    } catch (error) {
      console.warn("Push registration failed", error);
    }
  }

  private watchActivityTokens() {
    this.watching ??= native.onLiveActivityToken((token) => void this.activityToken(token)).catch((error: unknown) => {
      this.watching = undefined;
      console.warn("Live Activity token watch failed", error);
    });
  }

  private async activityToken(token: string) {
    if (!this.environment) return;
    try {
      const handle = await this.handle("liveactivity", token, this.environment);
      if (handle === this.handles.liveActivity) return;
      this.handles.liveActivity = handle;
      await this.registerAll();
    } catch (error) {
      console.warn("Live Activity push registration failed", error);
    }
  }

  private registerAll() {
    return Promise.all([...this.sessions].map((session) => this.register(session)));
  }

  private async register(session: Attachment) {
    const { alert, liveActivity } = this.handles;
    if (!session.supported || !session.runtime.connected || (!alert && !liveActivity)) return;
    try {
      const params = { deviceId: await this.deviceId(), alert, liveActivity } satisfies PushRegisterParams;
      await session.runtime.request("push.register", params);
      session.registered = true;
    } catch (error) {
      this.failed(session, error);
      return;
    }
    await this.state(session);
  }

  /** Hidden sends the activity iOS keeps showing, so the runtime can continue it with pushes. */
  private async state(session: Attachment) {
    if (!session.supported || !session.registered || !session.runtime.connected) return;
    const active = globalThis.document?.visibilityState !== "hidden";
    try {
      const deviceId = await this.deviceId();
      const params = (active ? { deviceId, active } : { deviceId, active, activity: session.activity() }) satisfies PushStateParams;
      await session.runtime.request("push.state", params);
    } catch (error) {
      this.failed(session, error);
    }
  }

  private failed(session: Attachment, error: unknown) {
    if ((error as { code?: unknown } | null)?.code === "METHOD_NOT_FOUND") session.supported = false;
    else console.warn("Runtime push request failed", error);
  }

  private deviceId() {
    this.device ??= native.storageGet<string>(SESSION_SCOPE, PUSH_DEVICE_KEY).then(async (stored) => {
      if (stored) return stored;
      const id = crypto.randomUUID();
      await native.storageSet(SESSION_SCOPE, PUSH_DEVICE_KEY, id);
      return id;
    });
    return this.device.catch((error: unknown) => {
      this.device = undefined;
      throw error;
    });
  }

  /** Posts the token to the relay unless the cache holds a handle for the same token. */
  private async handle(kind: PushTokenKind, token: string, environment: PushEnvironment) {
    this.cache ??= native.storageGet<HandleCache>(SESSION_SCOPE, PUSH_HANDLES_KEY).then((value) => value ?? {}, () => ({}));
    const cache = await this.cache;
    const cached = cache[kind];
    if (cached?.token === token && cached.environment === environment) return cached.handle;
    const body: PushDeviceRequest = { token, environment, kind };
    const response = await fetch(`${this.relay}/v1/devices`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`The push relay answered ${response.status}`);
    const { handle } = (await response.json()) as Partial<PushDeviceResponse>;
    if (typeof handle !== "string" || !handle) throw new Error("The push relay returned no handle");
    cache[kind] = { token, environment, handle };
    await native.storageSet(SESSION_SCOPE, PUSH_HANDLES_KEY, cache);
    return handle;
  }
}
