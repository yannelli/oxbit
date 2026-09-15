/* global browser, $, describe, it */
import assert from "node:assert/strict";
import path from "node:path";
import { copyFile, realpath } from "node:fs/promises";
import { execFileSync } from "node:child_process";

const project = path.join(process.env.OXBIT_NATIVE_FIXTURES, "Alpha project");

describe("Native media previews and file reveal", () => {
  it("opens the fixture project", async () => {
    for (const name of ["sample.pdf", "tone.mp3", "tone.wav"])
      await copyFile(
        new URL(`../fixtures/media/${name}`, import.meta.url),
        path.join(project, name),
      );
    await browser.waitUntil(() =>
      browser.execute(() => !!globalThis.__oxbitDesktop),
    );
    await browser.execute(
      async (project) => globalThis.__oxbitDesktop.native.open(project),
      project,
    );
    await browser.waitUntil(() =>
      browser.execute(() => !!globalThis.__oxbit?.ready),
    );
  });

  it("reveals the context-menu file in Finder even when another file is active", async () => {
    await browser.execute(async () => {
      const app = globalThis.__oxbit;
      await app.openFile("hello.ts");
      app.workbench.set({
        selectedPath: "tone.wav",
        menu: {
          name: "context",
          location: "explorer",
          ids: [],
          x: 200,
          y: 200,
        },
      });
    });
    const menuItem = await $(".context-menu [role=menuitem]");
    assert.equal(await menuItem.getText(), "View in Finder");
    await menuItem.click();
    const expected = await realpath(path.join(project, "tone.wav"));
    await browser.waitUntil(() => {
      const selected = execFileSync(
        "osascript",
        [
          "-e",
          'tell application "Finder" to get POSIX path of (item 1 of (get selection) as alias)',
        ],
        { encoding: "utf8" },
      ).trim();
      return selected === expected;
    });
  });

  for (const extension of ["mp3", "wav"]) {
    it(`plays ${extension} in WKWebView`, async () => {
      await browser.execute(
        async (name) => globalThis.__oxbit.openFile(name),
        `tone.${extension}`,
      );
      await browser.waitUntil(() =>
        browser.execute(() => document.querySelector("audio")?.duration > 1),
      );
      await $("audio").click();
      await browser.execute(async () => {
        const audio = document.querySelector("audio");
        audio.muted = true;
        await audio.play();
      });
      await browser.waitUntil(() =>
        browser.execute(() => document.querySelector("audio")?.currentTime > 0),
      );
      await browser.execute(() => document.querySelector("audio").pause());
    });
  }

  it("renders the PDF in WKWebView", async () => {
    await browser.execute(() => globalThis.__oxbit.openFile("sample.pdf"));
    await browser.waitUntil(() =>
      browser.execute(() =>
        document.querySelector(".pdf-preview")?.src.startsWith("blob:"),
      ),
    );
    await browser.waitUntil(() =>
      browser.execute(
        () =>
          !!document
            .querySelector(".pdf-preview")
            ?.contentDocument?.querySelector('embed[type="application/pdf"]'),
      ),
    );
    assert.equal(
      await browser.execute(
        () => !!globalThis.__oxbit.documents.get("sample.pdf"),
      ),
      false,
    );

    await browser.saveScreenshot("apps/desktop/native-results/media-pdf.png");
  });
});
