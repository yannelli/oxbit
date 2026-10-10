import { afterEach, describe, expect, it, vi } from "vitest";
import { IosNotification, installNotifications } from "./notifications.js";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

describe("iOS notifications", () => {
  afterEach(() => {
    invoke.mockReset();
    IosNotification.permission = "default";
  });

  it("installs only inside the Tauri app and reads the permission", async () => {
    const browser = {};
    installNotifications(browser);
    expect(browser).not.toHaveProperty("Notification");

    invoke.mockResolvedValue({ permission: "granted" });
    const app = { __TAURI_INTERNALS__: {} } as { __TAURI_INTERNALS__: object; Notification?: typeof IosNotification };
    installNotifications(app);
    expect(app.Notification).toBe(IosNotification);
    await vi.waitFor(() => expect(IosNotification.permission).toBe("granted"));
    expect(invoke).toHaveBeenCalledWith("plugin:oxbit-files|notification_permission");
  });

  it("requests permission and keeps the last state when the request fails", async () => {
    invoke.mockResolvedValueOnce({ permission: "denied" });
    await expect(IosNotification.requestPermission()).resolves.toBe("denied");
    invoke.mockRejectedValueOnce(new Error("unavailable"));
    await expect(IosNotification.requestPermission()).resolves.toBe("denied");
  });

  it("posts the title, body and tag", () => {
    invoke.mockResolvedValue(undefined);
    const notification = new IosNotification("Agent finished", { body: "Fix login", tag: "oxbit-agent-acp" });
    expect(notification.body).toBe("Fix login");
    expect(invoke).toHaveBeenCalledWith("plugin:oxbit-files|notify", { title: "Agent finished", body: "Fix login", tag: "oxbit-agent-acp" });
  });
});
