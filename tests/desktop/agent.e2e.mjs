/* global browser, describe, it */
import assert from "node:assert/strict";

const nativePermission = () =>
  browser.execute(async () => {
    try {
      return { permission: await globalThis.__TAURI_INTERNALS__.invoke("desktop_notification_permission") };
    } catch (error) {
      return { unavailable: String(error) };
    }
  });

describe("Oxbit native agent panel services", () => {
  it("backs Notification with the notification plugin in an unbundled binary", async function () {
    await browser.waitUntil(() => browser.execute(() => !!globalThis.__oxbitDesktop), { timeout: 30000 });
    const native = await nativePermission();
    if (native.permission) this.skip();
    assert.deepEqual(native, { unavailable: "Native notifications need a bundled Oxbit app" });
    const state = await browser.execute(() => ({
      permission: Notification.permission,
      native: Function.prototype.toString.call(Notification).includes("[native code]"),
    }));
    assert.deepEqual(state, { permission: "granted", native: false });
    const posted = await browser.execute(async () => {
      try {
        await globalThis.__TAURI_INTERNALS__.invoke("plugin:notification|notify", {
          options: { title: "Agent finished", body: "Oxbit native agent check" },
        });
        return "posted";
      } catch (error) {
        return String(error);
      }
    });
    assert.equal(posted, "posted");
    assert.equal(await browser.execute(() => {
      new Notification("Agent finished", { body: "Oxbit native agent check", tag: "oxbit-agent-acp" });
      return true;
    }), true);
  });

  it("posts through UNUserNotificationCenter in a bundled app", async function () {
    await browser.waitUntil(() => browser.execute(() => !!globalThis.__oxbitDesktop), { timeout: 30000 });
    const native = await nativePermission();
    if (native.unavailable) this.skip();
    // The desktop shim keeps permission as a data property; the plugin and WebKit use accessors.
    await browser.waitUntil(() => browser.execute(() =>
      !!globalThis.Notification && Object.getOwnPropertyDescriptor(globalThis.Notification, "permission")?.writable === true));
    assert.equal(await browser.execute(() => Notification.permission), native.permission);
    const [plugin, posted] = await browser.execute(async () => {
      const invoke = globalThis.__TAURI_INTERNALS__.invoke;
      const outcome = (call) => call.then(() => "posted", String);
      return [
        await outcome(invoke("plugin:notification|notify", { options: { title: "Agent finished" } })),
        await outcome(invoke("desktop_notify", { title: "Agent finished", body: "Oxbit native agent check", tag: "oxbit-agent-acp" })),
      ];
    });
    assert.notEqual(plugin, "posted");
    if (native.permission === "granted") assert.equal(posted, "posted");
    else assert.match(posted, /not allowed/i);
  });

  it("exposes speech recognition to the composer", async () => {
    const speech = await browser.execute(() => ({
      unprefixed: typeof globalThis.SpeechRecognition,
      prefixed: typeof globalThis.webkitSpeechRecognition,
    }));
    assert.deepEqual(speech, { unprefixed: "undefined", prefixed: "function" });
  });
});
