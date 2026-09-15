import { test, expect } from "@playwright/test";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// Use full Chromium: the headless shell does not include its PDF viewer.
test.use({ channel: "chromium" });

test.beforeEach(async ({ page }) => {
  const { root } = JSON.parse(
    await readFile("evidence/e2e-workspace.json", "utf8"),
  );
  for (const name of ["sample.pdf", "tone.mp3", "tone.wav"])
    await copyFile(`tests/fixtures/media/${name}`, path.join(root, name));
  await page.goto("/#pair=oxbit-acceptance-2026");
  await page.waitForFunction(() => (window as any).__oxbit?.ready);
});

test.describe("PDF rendering", () => {
  test("PDF opens as a binary preview with a downloadable original", async ({
    page,
  }) => {
    await page.evaluate(() => (window as any).__oxbit.openFile("sample.pdf"));
    const preview = page.getByTitle("PDF preview", { exact: true });
    await expect(preview).toBeVisible();
    await expect(preview).toHaveAttribute("src", /^blob:/);
    expect(
      await page.evaluate(() =>
        (window as any).__oxbit.documents.get("sample.pdf"),
      ),
    ).toBeUndefined();
    const download = page.waitForEvent("download");
    await page.getByRole("link", { name: "Download", exact: true }).click();
    expect(await readFile((await (await download).path())!)).toEqual(
      await readFile("tests/fixtures/media/sample.pdf"),
    );
    await expect
      .poll(() =>
        page
          .frames()
          .some((frame) => frame.url().startsWith("chrome-extension://")),
      )
      .toBe(true);
    const viewer = page
      .frames()
      .find((frame) => frame.url().startsWith("chrome-extension://"))!;
    await expect(viewer.locator("viewer-page-selector input")).toHaveValue("1");
    await page.screenshot({ path: "test-results/pdf-preview.png" });
  });
});

for (const extension of ["mp3", "wav"]) {
  test(`${extension} plays, seeks, pauses, and releases its URL when closed`, async ({
    page,
  }) => {
    await page.evaluate(
      (name) => (window as any).__oxbit.openFile(name),
      `tone.${extension}`,
    );
    const audio = page.locator("audio");
    await expect(audio).toBeVisible();
    await expect
      .poll(() => audio.evaluate((el: HTMLAudioElement) => el.duration))
      .toBeGreaterThan(1);
    expect(await audio.evaluate((el: HTMLAudioElement) => el.paused)).toBe(
      true,
    );
    await audio.evaluate(async (el: HTMLAudioElement) => {
      el.muted = true;
      await el.play();
    });
    await expect
      .poll(() => audio.evaluate((el: HTMLAudioElement) => el.currentTime))
      .toBeGreaterThan(0);
    await audio.evaluate((el: HTMLAudioElement) => {
      el.pause();
      el.currentTime = 1;
    });
    expect(
      await audio.evaluate((el: HTMLAudioElement) => ({
        paused: el.paused,
        position: el.currentTime,
      })),
    ).toEqual({ paused: true, position: 1 });
    const url = await audio.getAttribute("src");
    expect(
      await page.evaluate(
        (name) => (window as any).__oxbit.documents.get(name),
        `tone.${extension}`,
      ),
    ).toBeUndefined();
    await page.setViewportSize({ width: 393, height: 852 });
    const bounds = await audio.boundingBox();
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(393);
    await page.evaluate(() =>
      (window as any).__oxbit.kernel.commands.execute("editor.closeTab"),
    );
    await expect(audio).toHaveCount(0);
    expect(
      await page.evaluate(async (url) => {
        try {
          await fetch(url!);
          return false;
        } catch {
          return true;
        }
      }, url),
    ).toBe(true);
  });
}

test("an unsupported audio file shows an error and reloads after repair", async ({
  page,
}) => {
  const { root } = JSON.parse(
    await readFile("evidence/e2e-workspace.json", "utf8"),
  );
  await writeFile(path.join(root, "broken.wav"), "invalid audio");
  await page.evaluate(() => (window as any).__oxbit.openFile("broken.wav"));
  await expect(page.getByRole("alert")).toContainText("codec is not supported");
  await copyFile(
    "tests/fixtures/media/tone.wav",
    path.join(root, "broken.wav"),
  );
  await page.getByRole("button", { name: "Reload preview" }).click();
  await expect
    .poll(() =>
      page.locator("audio").evaluate((el: HTMLAudioElement) => el.duration),
    )
    .toBeGreaterThan(1);
});

test("a file renamed to PDF shows a clear error", async ({ page }) => {
  const { root } = JSON.parse(
    await readFile("evidence/e2e-workspace.json", "utf8"),
  );
  await writeFile(path.join(root, "invalid.pdf"), "Not a PDF");
  await page.evaluate(() => (window as any).__oxbit.openFile("invalid.pdf"));
  await expect(page.getByRole("alert")).toHaveText(
    "This file is not a PDF document.",
  );
});
