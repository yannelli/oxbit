import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopNotification, installNotifications, watchNotificationClicks } from "./notifications.js";

const { invoke, channels } = vi.hoisted(() => ({
  invoke: vi.fn(),
  channels: [] as { id: number; onmessage: (tag: string) => void }[],
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  Channel: class {
    id = channels.length + 1;
    constructor(public onmessage: (tag: string) => void) {
      channels.push(this);
    }
  },
}));

describe("desktop notifications", () => {
  afterEach(() => {
    invoke.mockReset();
    channels.length = 0;
    DesktopNotification.permission = "default";
  });

  it("installs only when the native permission answers", async () => {
    const browser = {};
    await expect(installNotifications(browser)).resolves.toBe(false);
    expect(browser).not.toHaveProperty("Notification");

    invoke.mockRejectedValueOnce(new Error("Native notifications need a bundled Oxbit app"));
    const unbundled = { __TAURI_INTERNALS__: {}, Notification: "plugin" };
    await expect(installNotifications(unbundled)).resolves.toBe(false);
    expect(unbundled.Notification).toBe("plugin");

    invoke.mockResolvedValue("granted");
    const app = { __TAURI_INTERNALS__: {} } as { __TAURI_INTERNALS__: object; Notification?: unknown };
    await expect(installNotifications(app)).resolves.toBe(true);
    expect(app.Notification).toBe(DesktopNotification);
    expect(DesktopNotification.permission).toBe("granted");
    expect(invoke).toHaveBeenCalledWith("desktop_notification_permission");
  });

  it("requests permission and keeps the last state when the request fails", async () => {
    invoke.mockResolvedValueOnce("denied");
    await expect(DesktopNotification.requestPermission()).resolves.toBe("denied");
    expect(invoke).toHaveBeenCalledWith("desktop_notification_request_permission");
    invoke.mockRejectedValueOnce(new Error("unavailable"));
    await expect(DesktopNotification.requestPermission()).resolves.toBe("denied");
  });

  it("posts the title, body and tag", () => {
    invoke.mockResolvedValue(undefined);
    const notification = new DesktopNotification("Agent finished", { body: "Fix login", tag: "oxbit-agent-acp" });
    expect(notification.body).toBe("Fix login");
    expect(invoke).toHaveBeenCalledWith("desktop_notify", { title: "Agent finished", body: "Fix login", tag: "oxbit-agent-acp" });
  });

  it("sends a click to the latest notification with its tag", async () => {
    invoke.mockResolvedValue(undefined);
    const unclaimed = vi.fn();
    const watch = await watchNotificationClicks(unclaimed);
    expect(invoke).toHaveBeenCalledWith("desktop_notification_watch", { channel: channels[0] });
    const older = new DesktopNotification("Agent needs your input", { tag: "oxbit-agent-acp" });
    const newer = new DesktopNotification("Agent finished", { tag: "oxbit-agent-acp" });
    const other = new DesktopNotification("Build", { tag: "build" });
    older.onclick = vi.fn();
    newer.onclick = vi.fn();
    other.onclick = vi.fn();

    channels[0].onmessage("oxbit-agent-acp");
    expect(newer.onclick).toHaveBeenCalledWith(expect.any(Event));
    expect(older.onclick).not.toHaveBeenCalled();
    expect(other.onclick).not.toHaveBeenCalled();
    expect(unclaimed).not.toHaveBeenCalled();

    newer.close();
    channels[0].onmessage("oxbit-agent-acp");
    expect(newer.onclick).toHaveBeenCalledOnce();
    expect(unclaimed).toHaveBeenCalledWith("oxbit-agent-acp");

    await watch.unregister();
    expect(invoke).toHaveBeenCalledWith("desktop_notification_unwatch", { id: channels[0].id });
  });
});
