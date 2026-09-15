/* global browser, $, describe, it */
import assert from "node:assert/strict";
import path from "node:path";

describe("Integrated macOS title bar", () => {
  it("reserves native controls in the welcome header", async () => {
    await browser.waitUntil(() => browser.execute(() => !!globalThis.__oxbitDesktop));
    const header = await browser.execute(() => {
      const header = document.querySelector(".titlebar");
      return {
        platform: document.documentElement.dataset.nativeTitlebar,
        top: header.getBoundingClientRect().top,
        height: header.getBoundingClientRect().height,
        projectLeft: header.querySelector("button").getBoundingClientRect().left,
      };
    });
    assert.equal(header.platform, "macos");
    assert.equal(header.top, 0);
    assert.equal(header.height, 40);
    assert.ok(header.projectLeft >= 88);
  });

  it("keeps menus and search interactive beside the traffic lights", async () => {
    await browser.execute(async (project) => globalThis.__oxbitDesktop.native.open(project),
      path.join(process.env.OXBIT_NATIVE_FIXTURES, "Alpha project"));
    await browser.waitUntil(() => browser.execute(() => !!globalThis.__oxbit?.ready));
    const header = await browser.execute(() => {
      const header = document.querySelector(".workbench .titlebar");
      return {
        top: header.getBoundingClientRect().top,
        height: header.getBoundingClientRect().height,
        menuLeft: header.querySelector(".menu-parent").getBoundingClientRect().left,
        hiddenBrand: getComputedStyle(header.querySelector(".brand")).display === "none",
      };
    });
    assert.deepEqual({ top: header.top, height: header.height, hiddenBrand: header.hiddenBrand },
      { top: 0, height: 40, hiddenBrand: true });
    assert.ok(header.menuLeft >= 88);
    await $("button=View").click();
    await $(".command-menu").waitForDisplayed();
    await browser.keys("Escape");
    await $(".title-search").click();
    await $(".palette").waitForDisplayed();
    await browser.keys("Escape");
  });

  it("keeps the editor below the window controls in focus mode", async () => {
    await browser.execute(() => globalThis.__oxbit.workbench.set({ focus: true }));
    await browser.waitUntil(() => browser.execute(() => {
      const editor = document.querySelector(".editor-groups");
      return !document.querySelector(".workbench .titlebar")
        && editor.getBoundingClientRect().top >= 40;
    }));
    await browser.execute(() => globalThis.__oxbit.workbench.set({ focus: false }));
    await $(".titlebar").waitForDisplayed();
    await browser.saveScreenshot("apps/desktop/native-results/integrated-titlebar.png");
  });
});
