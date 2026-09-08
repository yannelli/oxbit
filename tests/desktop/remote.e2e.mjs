/* global browser, $, describe, it */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";

describe("SSH connector in the native WebView", () => {
  it("opens an accessible connection dialog and validates remote locations", async () => {
    await browser.waitUntil(
      () => browser.execute(() => !!globalThis.__oxbitDesktop),
      { timeout: 30000 },
    );
    await $("#project-switcher").click();
    await $("button=Connect over SSH…").click();
    await $(".ssh-form").waitForExist();
    await browser.execute(() =>
      document
        .querySelector(".dialog")
        .getAnimations()
        .forEach((animation) => animation.finish()),
    );
    await $(".ssh-form").waitForDisplayed();
    await browser.waitUntil(() =>
      browser.execute(
        () =>
          document.activeElement === document.querySelector(".ssh-form input"),
      ),
    );
    const host = $(".ssh-form label:nth-of-type(1) input");
    const path = $(".ssh-form label:nth-of-type(2) input");
    const port = $(".ssh-form label:nth-of-type(3) input");
    await host.setValue("user@host bad");
    await $(".ssh-form button[type=submit]").click();
    assert.match(
      await $(".ssh-form [role=alert]").getText(),
      /SSH config alias/,
    );
    await host.setValue("ryan@dev");
    await path.setValue("~/my project/hello.ts");
    await port.setValue("70000");
    await $(".ssh-form button[type=submit]").click();
    assert.match(await $(".ssh-form [role=alert]").getText(), /65535/);
    await port.setValue("2222");
    await fs.mkdir("evidence/remote-ssh", { recursive: true });
    await browser.saveScreenshot("evidence/remote-ssh/native-dialog.png");
    // Capture the UI submission; the actual SSH transport has its own real-server smoke test.
    await browser.execute(() => {
      globalThis.__sshOriginalOpen =
        globalThis.__oxbitDesktop.native.openRemote;
      globalThis.__oxbitDesktop.native.openRemote = async (target) => {
        globalThis.__sshSubmitted = target;
        return "test";
      };
    });
    try {
      await $(".ssh-form button[type=submit]").click();
      await browser.waitUntil(() =>
        browser.execute(() => !!globalThis.__sshSubmitted),
      );
      assert.equal(
        await browser.execute(() => globalThis.__sshSubmitted),
        "ssh://ryan@dev:2222/~/my%20project/hello.ts",
      );
      assert.equal(await $(".ssh-form").isExisting(), false);
    } finally {
      await browser.execute(() => {
        globalThis.__oxbitDesktop.native.openRemote =
          globalThis.__sshOriginalOpen;
      });
    }
    await $("#project-switcher").click();
    await $("button=Connect over SSH…").click();
    await $(".ssh-form").waitForExist();
    await browser.execute(() =>
      document
        .querySelector(".dialog")
        .getAnimations()
        .forEach((animation) => animation.finish()),
    );
    await browser.keys("Escape");
    assert.equal(await $(".ssh-form").isExisting(), false);
    assert.equal(
      await browser.execute(async () => {
        try {
          await globalThis.__oxbitDesktop.native.openRemote(
            "ssh://user:password@host/path",
          );
          return false;
        } catch {
          return true;
        }
      }),
      true,
    );
  });
});
