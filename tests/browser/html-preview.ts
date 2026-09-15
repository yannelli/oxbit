import { expect, test, type Page } from "@playwright/test";

async function fixture(page: Page, remote = false) {
  await page.goto("/");
  await page.waitForFunction(() => (window as any).__oxbit?.ready === true);
  if (remote) {
    await page.evaluate(() => (window as any).__oxbit.connectRuntime(location.origin, "oxbit-acceptance-2026"));
    await page.waitForFunction(() => (window as any).__oxbit?.runtime?.connected);
  }
  await page.evaluate(async () => {
    const app = (window as any).__oxbit;
    const files = {
      "site/index.html": `<!doctype html><html><head><link rel="stylesheet" href="css/main.css"></head><body data-theme="preview">
        <h1>HTML preview works</h1><img alt="Local image" src="/site/images/mark.svg">
        <img alt="Responsive image" srcset="images/mark.svg 1x, images/mark.svg 2x">
        <div class="background">Background image</div><a href="next.htm">Next page</a>
        <script>parent.__previewExecuted = true; document.querySelector('h1').textContent = 'Unsafe';</script>
        <button onclick="parent.__previewExecuted = true">Script action</button>
      </body></html>`,
      "site/next.htm": '<h1>Second HTML page</h1><p>Local navigation works.</p>',
      "site/css/main.css": '@import "colors.css"; body { margin: 16px; font: 16px system-ui } .background { background-image: url("../images/mark.svg"); width: 32px; height: 32px; overflow: hidden }',
      "site/css/colors.css": '[data-theme="preview"] h1 { color: rgb(12, 100, 88) }',
      "site/images/mark.svg": '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="#4cc"/></svg>',
    };
    for (const directory of ["site", "site/css", "site/images"])
      await app.filesystem.list(directory).catch(() => app.filesystem.mkdir(directory));
    for (const [path, text] of Object.entries(files)) {
      const previous = await app.filesystem.read(path).catch(() => undefined);
      await app.filesystem.write(path, text, { expectedRevision: previous?.revision ?? null });
    }
    await app.workbench.openFile("site/index.html", { preview: false });
  });
}

export function htmlPreviewTests() {
  test("HTML preview loads local CSS and images, updates drafts, and navigates pages", async ({ page }) => {
    await fixture(page);
    await page.getByRole("button", { name: "Open HTML preview", exact: true }).click();
    const preview = page.frameLocator('iframe[title="HTML preview"]');
    await expect(preview.getByRole("heading", { name: "HTML preview works" })).toBeVisible();
    await expect(preview.locator("h1")).toHaveCSS("color", "rgb(12, 100, 88)");
    await expect.poll(() => preview.getByAltText("Local image").evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(24);
    // srcset density descriptors adjust the intrinsic CSS width of the decoded image.
    await expect.poll(() => preview.getByAltText("Responsive image").evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
    await expect(preview.locator(".background")).toHaveCSS("background-image", /data:image\/svg\+xml/);
    await expect(page.locator(".html-document details")).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__previewExecuted)).toBeUndefined();
    await preview.getByRole("button", { name: "Script action" }).click();
    expect(await page.evaluate(() => (window as any).__previewExecuted)).toBeUndefined();

    await page.evaluate(async () => {
      const app = (window as any).__oxbit;
      const css = await app.documents.open("site/css/colors.css");
      css.replace('h1 { color: rgb(180, 40, 90) }');
      const doc = app.documents.get("site/index.html");
      doc.replace(doc.text.toString().replace("HTML preview works", "Unsaved HTML preview"));
    });
    await expect(preview.locator("h1")).toHaveText("Unsaved HTML preview");
    await expect(preview.locator("h1")).toHaveCSS("color", "rgb(180, 40, 90)");
    await page.evaluate(async () => {
      const filesystem = (window as any).__oxbit.filesystem;
      const image = await filesystem.read("site/images/mark.svg");
      await filesystem.write(image.path, image.text.replace('width="24"', 'width="48"'), { expectedRevision: image.revision });
    });
    await expect.poll(() => preview.getByAltText("Local image").evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(48);
    await preview.getByRole("link", { name: "Next page" }).click();
    await expect(preview.locator("h1")).toHaveText("Second HTML page");
    await page.getByRole("button", { name: "Back in HTML preview" }).click();
    await expect(preview.locator("h1")).toHaveText("Unsaved HTML preview");

    const bounds = await page.locator(".html-document").boundingBox();
    const viewport = page.viewportSize()!;
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
    if (viewport.width < 650) {
      await expect(page.locator(".panel-dock")).toHaveCount(0);
      const frameBounds = await page.locator(".html-preview-frame").boundingBox();
      const nav = await page.locator(".activity-bar").boundingBox();
      expect(frameBounds!.y + frameBounds!.height).toBeLessThanOrEqual(nav!.y + 1);
    }
    await page.getByRole("button", { name: "Open source", exact: true }).click();
    await expect(page.locator(".cm-content")).toContainText("Unsaved HTML preview");
  });

  test("HTML preview reads styles and images from a connected runtime", async ({ page }) => {
    await fixture(page, true);
    await page.getByRole("button", { name: "Open HTML preview", exact: true }).click();
    const preview = page.frameLocator('iframe[title="HTML preview"]');
    await expect(preview.locator("h1")).toHaveText("HTML preview works");
    await expect(preview.locator("h1")).toHaveCSS("color", "rgb(12, 100, 88)");
    await expect.poll(() => preview.getByAltText("Local image").evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(24);
    await expect(page.locator(".html-document details")).toHaveCount(0);
  });

  test("HTML preview reports missing resources and prevents workspace escapes and navigation", async ({ page }) => {
    await fixture(page);
    const requests: string[] = [];
    page.on("request", request => { if (request.url().includes("preview-leak.invalid")) requests.push(request.url()); });
    await page.evaluate(() => {
      const app = (window as any).__oxbit;
      app.documents.get("site/index.html").replace(`<meta http-equiv="refresh" content="0;url=https://preview-leak.invalid/">
        <base href="https://preview-leak.invalid/"><h1>Safe preview</h1>
        <img src="../../outside.png"><img src="missing.png"><img src="https://preview-leak.invalid/leak">
        <iframe src="https://preview-leak.invalid/"></iframe><a href="https://preview-leak.invalid/">External</a>
        <style>h1{background:url(https://preview-leak.invalid/css)}</style>`);
    });
    await page.getByRole("button", { name: "Open HTML preview", exact: true }).click();
    const preview = page.frameLocator('iframe[title="HTML preview"]');
    await expect(preview.locator("h1")).toHaveText("Safe preview");
    await expect(page.getByText("Some preview resources could not be loaded")).toBeVisible();
    await expect(preview.locator("iframe, script:not([data-path]), base, meta[http-equiv=refresh]")).toHaveCount(0);
    await expect(page.locator(".html-preview-frame")).toHaveAttribute("sandbox", "allow-scripts");
    await expect(preview.getByRole("link", { name: "External" })).toHaveAttribute("href", "#");
    expect(requests).toEqual([]);
  });
}
