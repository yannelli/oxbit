import type { Setting } from "@oxbit/sdk";

export const BACKGROUND_LOCATION_SETTING = "runtime.backgroundLocation";

export const backgroundLocationSetting: Setting = {
  id: BACKGROUND_LOCATION_SETTING,
  title: "Stay Connected in the Background",
  description:
    "Use approximate location while a runtime, SSH connection or agent turn is open, so iOS keeps terminals and agents connected when you switch apps. The location indicator shows while it runs. Oxbit does not store or send your location.",
  type: "boolean",
  category: "Runtime",
  default: false,
};

export interface BackgroundLocationResult {
  active: boolean;
  authorization: "granted" | "prompt" | "denied";
}

export interface KeepAliveState {
  enabled: boolean;
  /** A runtime or SSH connection is open. */
  connected: boolean;
  /** An agent turn is working or waiting for the user. */
  working: boolean;
}

/** iOS starts location updates only for a visible app, so a start requested while hidden waits for `visible()`. */
export class BackgroundKeepAlive {
  private state: KeepAliveState = { enabled: false, connected: false, working: false };
  private active = false;
  private denied = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly request: (enabled: boolean) => Promise<BackgroundLocationResult>,
    private readonly isVisible: () => boolean,
    private readonly onDenied: () => void,
  ) {}

  update(change: Partial<KeepAliveState>) {
    if (change.enabled === true && !this.state.enabled) this.denied = false;
    this.state = { ...this.state, ...change };
    return this.sync();
  }

  visible() { return this.sync(); }

  dispose() {
    this.state = { enabled: false, connected: false, working: false };
    return this.sync();
  }

  private wanted() {
    return this.state.enabled && !this.denied && (this.state.connected || this.state.working);
  }

  private sync() {
    this.queue = this.queue.then(async () => {
      const wanted = this.wanted();
      if (wanted === this.active || (wanted && !this.isVisible())) return;
      const result = await this.request(wanted).catch((): BackgroundLocationResult => ({ active: false, authorization: "prompt" }));
      this.active = result.active;
      if (wanted && result.authorization === "denied") {
        this.denied = true;
        this.onDenied();
      }
    });
    return this.queue;
  }
}
