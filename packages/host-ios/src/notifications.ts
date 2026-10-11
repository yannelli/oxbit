import { invoke } from "@tauri-apps/api/core";

export type NotificationPermission = "default" | "denied" | "granted";

const grantListeners = new Set<() => void>();

function permission(command: "notification_permission" | "request_notification_permission") {
  return invoke<{ permission: NotificationPermission }>(`plugin:oxbit-files|${command}`).then((result) => {
    const previous = IosNotification.permission;
    IosNotification.permission = result.permission;
    if (result.permission === "granted" && previous !== "granted") for (const listener of grantListeners) listener();
    return result.permission;
  });
}

/** Reads the permission from iOS. */
export function notificationPermission(): Promise<NotificationPermission> {
  return permission("notification_permission");
}

/** Runs `listener` each time the permission turns `granted`, from a request or from Settings. */
export function onNotificationGrant(listener: () => void): () => void {
  grantListeners.add(listener);
  return () => grantListeners.delete(listener);
}

/** Web `Notification` backed by the oxbit-files plugin. Taps reach `native.onNotificationTap`. */
export class IosNotification {
  static permission: NotificationPermission = "default";
  static requestPermission(): Promise<NotificationPermission> {
    return permission("request_notification_permission").catch(() => IosNotification.permission);
  }
  onclick: ((event: Event) => void) | null = null;
  readonly body: string;
  readonly tag: string;

  constructor(readonly title: string, options: { body?: string; tag?: string } = {}) {
    this.body = options.body ?? "";
    this.tag = options.tag ?? "";
    invoke("plugin:oxbit-files|notify", { title, body: options.body, tag: options.tag }).catch((error: unknown) =>
      console.warn("Notification failed", error),
    );
  }

  close(): void {}
}

/** Installs `IosNotification` as `Notification`; its permission refreshes whenever the app returns. */
export function installNotifications(target: object = globalThis): void {
  if (!("__TAURI_INTERNALS__" in target)) return;
  Object.defineProperty(target, "Notification", { value: IosNotification, configurable: true, writable: true });
  const refresh = () => void permission("notification_permission").catch(() => undefined);
  refresh();
  globalThis.document?.addEventListener("visibilitychange", refresh);
}
