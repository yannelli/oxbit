/* global browser, $, describe, it */
import assert from "node:assert/strict";
import path from "node:path";
const active = () => browser.execute(() => globalThis.__oxbit?.ready && globalThis.__oxbit.workbench === globalThis.__oxbitDesktop.manager.active?.session?.workbench);
describe("Native language intelligence", () => {
  it("keeps untrusted local language support and status scoped to the current file", async () => {
    await browser.waitUntil(() => browser.execute(() => !!globalThis.__oxbitDesktop), { timeout: 30000 });
    // The embedded driver's occluded WebView suppresses animation frames. Keep the
    // production layout callbacks running without altering geometry or editor code.
    await browser.execute(() => {
      if (document.visibilityState === "hidden") {
        window.requestAnimationFrame = callback => setTimeout(() => callback(performance.now()), 16);
        window.cancelAnimationFrame = id => clearTimeout(id);
      }
    });
    await browser.execute(async folder => globalThis.__oxbitDesktop.native.open(folder), path.join(process.env.OXBIT_NATIVE_FIXTURES, "Alpha project"));
    await browser.waitUntil(active, { timeout: 40000 });
    assert.equal(await browser.execute(() => globalThis.__oxbit.runtime.session.trusted), false);
    await browser.execute(() => globalThis.__oxbit.openFile("language.ini"));
    await browser.waitUntil(() => browser.execute(() => globalThis.__oxbit.kernel.services.get("language").servers.some(server => server.state === "ready")));
    await $(".lsp-status-trigger").click();
    assert.match(await $(".lsp-server-list").getText(), /ini/i);
    assert.doesNotMatch(await $(".lsp-server-list").getText(), /TypeScript|CSV/i);
    await browser.execute(() => globalThis.__oxbit.openFile("language.csv"));
    await browser.waitUntil(async () => /csv/i.test(await $(".lsp-server-list").getText()));
    assert.doesNotMatch(await $(".lsp-server-list").getText(), /TypeScript|INI/i);
    await browser.saveScreenshot(path.resolve("evidence/language-milestone1/native/local-status.png"));
    await $("[aria-label='Close Language Servers']").click();
  });
  it("renders real semantic tokens, hints and keyboard hover and opens SDK sources read-only", async () => {
    await browser.execute(async () => { const app = globalThis.__oxbit; await app.runtime.trust(true); await app.openFile("hello.ts"); });
    await browser.waitUntil(() => browser.execute(() => globalThis.__oxbit.kernel.services.get("language").servers.some(server => server.state === "ready")), { timeout: 120000 });
    await $(".lsp-semantic").waitForExist({ timeout: 30000 });
    await $(".lsp-inlay-hint").waitForExist({ timeout: 30000 });
    await browser.execute(async () => { const app = globalThis.__oxbit, view = app.workbench.activeEditor(); view.dispatch({ selection: { anchor: 17 } }); view.focus(); await app.kernel.commands.execute("editor.hover"); });
    await $(".lsp-tooltip").waitForDisplayed(); assert.match(await $(".lsp-tooltip").getText(), /greet/);
    await browser.execute(() => new Promise(resolve => setTimeout(resolve, 100)));
    await browser.waitUntil(() => browser.execute(() => { const rect = document.querySelector(".lsp-tooltip")?.getBoundingClientRect(); return rect && rect.top >= 0 && rect.bottom <= innerHeight; }), { timeout: 10000, timeoutMsg: "Native documentation was not positioned inside the viewport" });
    await browser.saveScreenshot(path.resolve("evidence/language-milestone1/native/semantic-hover.png"));
    await browser.execute(async () => { const app = globalThis.__oxbit, view = app.workbench.activeEditor(); view.dispatch({ selection: { anchor: view.state.doc.line(3).from + 13 } }); await app.kernel.commands.execute("editor.gotoDefinition"); });
    const source = $("[aria-label^='Read-only lib.']"); await source.waitForExist({ timeout: 30000 });
    assert.equal(await source.$(".cm-content").getAttribute("contenteditable"), "false");
    await source.$(".cm-line").waitForDisplayed();
    await browser.waitUntil(async () => /toUpperCase/.test(await source.getText()), { timeout: 10000, timeoutMsg: "External source did not render its target line" });
    await browser.execute(() => new Promise(resolve => setTimeout(resolve, 100)));
    await browser.saveScreenshot(path.resolve("evidence/language-milestone1/native/external-source.png"));
  });
});
