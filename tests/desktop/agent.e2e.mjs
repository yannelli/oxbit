/* global browser, describe, it */
import assert from "node:assert/strict";

describe("Oxbit native agent panel services", () => {
  it("backs Notification with the notification plugin", async () => {
    await browser.waitUntil(() => browser.execute(() => !!globalThis.__oxbitDesktop), { timeout: 30000 });
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

  it("exposes speech recognition to the composer", async () => {
    const speech = await browser.execute(() => ({
      unprefixed: typeof globalThis.SpeechRecognition,
      prefixed: typeof globalThis.webkitSpeechRecognition,
    }));
    assert.deepEqual(speech, { unprefixed: "undefined", prefixed: "function" });
  });
});
