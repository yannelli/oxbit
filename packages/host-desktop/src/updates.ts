import type { Setting } from "@oxbit/sdk";

export interface UpdateStatus {
  status: "manual" | "unconfigured" | "available" | "current";
  version?: string;
  notes?: string;
  url?: string;
}

export const AUTO_UPDATE_SETTING: Setting = {
  id: "update.checkAutomatically",
  title: "Check for Updates Automatically",
  description: "Checks for a new Oxbit desktop release at launch and every hour.",
  type: "boolean",
  default: true,
  category: "Application",
};

export const UPDATE_INTERVAL = 60 * 60 * 1000;

/** Checks now and every `interval` while `enabled()` is true, and announces each available version once. */
export function watchUpdates(options: {
  check(): Promise<UpdateStatus>;
  enabled(): boolean;
  announce(status: UpdateStatus): void;
  interval?: number;
}): () => void {
  let announced: string | undefined;
  const run = async () => {
    if (!options.enabled()) return;
    try {
      const status = await options.check();
      if (status.status === "available" && status.version !== announced && options.enabled()) {
        announced = status.version;
        options.announce(status);
      }
    } catch {
      // Background checks stay quiet; Check for Updates reports the error.
    }
  };
  void run();
  const timer = setInterval(() => void run(), options.interval ?? UPDATE_INTERVAL);
  return () => clearInterval(timer);
}
