import { Channel, invoke } from "@tauri-apps/api/core";

export type NotificationPermission = "default" | "denied" | "granted";

const latest = new Map<string, DesktopNotification>();

function permission(command: "desktop_notification_permission" | "desktop_notification_request_permission") {
  return invoke<NotificationPermission>(command).then((result) => (DesktopNotification.permission = result));
}

/** Web `Notification` posted through UNUserNotificationCenter on macOS. */
export class DesktopNotification {
  static permission: NotificationPermission = "default";
  static requestPermission(): Promise<NotificationPermission> {
    return permission("desktop_notification_request_permission").catch(() => DesktopNotification.permission);
  }
  onclick: ((event: Event) => void) | null = null;
  readonly body: string;
  readonly tag: string;

  constructor(readonly title: string, options: { body?: string; tag?: string } = {}) {
    this.body = options.body ?? "";
    this.tag = options.tag ?? "";
    if (this.tag) latest.set(this.tag, this);
    invoke("desktop_notify", { title, body: options.body, tag: options.tag }).catch((error: unknown) =>
      console.warn("Notification failed", error),
    );
  }

  close(): void {
    if (latest.get(this.tag) === this) latest.delete(this.tag);
  }
}

/** Installs `DesktopNotification` as `Notification` once the native permission answers; resolves false otherwise. */
export async function installNotifications(target: object = globalThis): Promise<boolean> {
  if (!("__TAURI_INTERNALS__" in target)) return false;
  try {
    await permission("desktop_notification_permission");
  } catch {
    return false;
  }
  Object.defineProperty(target, "Notification", { value: DesktopNotification, configurable: true, writable: true });
  globalThis.document?.addEventListener("visibilitychange", () =>
    void permission("desktop_notification_permission").catch(() => undefined),
  );
  return true;
}

/** Calls `onclick` of the latest notification with the clicked tag, or `unclaimed` when this window holds none. */
export async function watchNotificationClicks(unclaimed: (tag: string) => void) {
  const channel = new Channel<string>((tag) => {
    const notification = latest.get(tag);
    if (notification) notification.onclick?.(new Event("click"));
    else unclaimed(tag);
  });
  await invoke("desktop_notification_watch", { channel });
  return { unregister: () => invoke<void>("desktop_notification_unwatch", { id: channel.id }) };
}
