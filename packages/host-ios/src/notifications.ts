import { invoke } from "@tauri-apps/api/core";

export type NotificationPermission = "default" | "denied" | "granted";

function permission(command: "notification_permission" | "request_notification_permission") {
  return invoke<{ permission: NotificationPermission }>(`plugin:oxbit-files|${command}`).then(
    (result) => (IosNotification.permission = result.permission),
  );
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
