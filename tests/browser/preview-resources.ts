import { expect, test, type Locator, type Page } from "@playwright/test";

const origin = "https://preview-resources.invalid";
const mark = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="#4cc"/></svg>';

async function resources(page: Page) {
  const requests: string[] = [];
  page.on("request", request => {
    if (request.url().startsWith(origin)) requests.push(new URL(request.url()).pathname);
  });
  await page.route(`${origin}/**`, async route => {
    const path = new URL(route.request().url()).pathname;
    const assets: Record<string, [string, string]> = {
      "/style.css": ["text/css", '@import url("imported.css"); h1 { color: rgb(12, 100, 88) } .remote-background { background-image: url("background.svg") }'],
      "/imported.css": ["text/css", "h1 { border-bottom: 3px solid rgb(12, 100, 88) }"],
      "/script.js": ["text/javascript", 'document.documentElement.dataset.scriptExecuted = "true"'],
    };
    const [contentType, body] = assets[path] ?? ["image/svg+xml", mark];
    await route.fulfill({ contentType, body, headers: { "access-control-allow-origin": "*", "cache-control": "no-store" } });
  });
  return requests;
}

async function fixture(page: Page, extension: "html" | "md") {
  if (page.viewportSize()!.width < 650) await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("/");
  await page.waitForFunction(() => (window as any).__oxbit?.ready === true);
  await page.evaluate(async ({ origin, mark, extension }) => {
    const app = (window as any).__oxbit;
    const files = {
      "resource-preview/index.html": `<!doctype html><html><head><link rel="stylesheet" href="${origin}/style.css">
        <style>body { margin: 8px; font: 16px system-ui } h1 { font-size: 20px } .remote-background { width: 24px; height: 24px }</style>
        </head><body><h1>Resource trust</h1><img alt="Local image" src="mark.svg">
        <img alt="Remote image" src="${origin}/remote.svg">
        <img alt="Remote responsive image" srcset="${origin}/responsive.svg 1x, ${origin}/responsive.svg 2x">
        <div class="remote-background"></div>
        <script>document.documentElement.dataset.scriptExecuted = "true"</script>
        <script src="${origin}/script.js"></script>
        <button onclick="document.documentElement.dataset.scriptExecuted = 'true'">Script action</button></body></html>`,
      "resource-preview/index.md": `# Markdown resource trust\n\n![Local image](mark.svg)\n\n![Remote image](${origin}/markdown.svg)\n`,
      "resource-preview/mark.svg": mark,
    };
    await app.filesystem.list("resource-preview").catch(() => app.filesystem.mkdir("resource-preview"));
    for (const [path, text] of Object.entries(files)) {
      const previous = await app.filesystem.read(path).catch(() => undefined);
      await app.filesystem.write(path, text, { expectedRevision: previous?.revision ?? null });
    }
    await app.workbench.openFile(`resource-preview/index.${extension}`, { preview: false });
  }, { origin, mark, extension });
}

async function activate(page: Page, control: Locator) {
  if (page.viewportSize()!.width < 650) await control.tap();
  else await control.click();
}

async function phoneControls(page: Page, document: Locator) {
  if (page.viewportSize()!.width >= 650) return;
  const viewport = page.viewportSize()!;
  const bounds = (await document.boundingBox())!;
  const navigation = (await page.locator(".activity-bar").boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(navigation.y + 1);
  for (const control of await document.locator(".preview-toolbar button, .preview-resource-control select").all()) {
    const box = (await control.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    expect(box.y + box.height).toBeLessThanOrEqual(navigation.y);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

export function previewResourceTests() {
  test("HTML resource trust loads external styles and images and keeps scripts disabled", async ({ page }) => {
    const requests = await resources(page);
    await fixture(page, "html");
    await activate(page, page.getByRole("button", { name: "Open HTML preview", exact: true }));
    const document = page.locator(".html-document");
    const preview = page.frameLocator('iframe[title="HTML preview"]');
    const trust = page.getByLabel("External resources", { exact: true });
    await expect(preview.locator("h1")).toHaveText("Resource trust");
    await expect(document).toHaveAttribute("aria-busy", "false");
    await expect(trust).toHaveValue("local");
    await expect.poll(() => preview.getByAltText("Local image", { exact: true }).evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(24);
    await expect(preview.getByAltText("Remote image", { exact: true })).toHaveAttribute("src", "data:,");
    expect(requests).toEqual([]);
    await phoneControls(page, document);

    await trust.selectOption("external");
    await expect(preview.locator("h1")).toHaveCSS("color", "rgb(12, 100, 88)");
    await expect(preview.locator("h1")).toHaveCSS("border-bottom-width", "3px");
    await expect.poll(() => preview.getByAltText("Remote image", { exact: true }).evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(24);
    await expect.poll(() => preview.getByAltText("Remote responsive image").evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
    await expect.poll(() => requests).toEqual(expect.arrayContaining(["/style.css", "/imported.css", "/remote.svg", "/responsive.svg", "/background.svg"]));
    await activate(page, preview.getByRole("button", { name: "Script action" }));
    await expect(preview.locator("html")).not.toHaveAttribute("data-script-executed", "true");
    expect(requests).not.toContain("/script.js");

    await page.evaluate(() => {
      const doc = (window as any).__oxbit.documents.get("resource-preview/index.html");
      doc.replace(doc.text.toString().replace("Resource trust", "Trusted draft"));
    });
    await expect(preview.locator("h1")).toHaveText("Trusted draft");
    await expect(trust).toHaveValue("external");
    await expect(preview.locator("h1")).toHaveCSS("color", "rgb(12, 100, 88)");

    await trust.selectOption("local");
    await expect(preview.getByAltText("Remote image", { exact: true })).toHaveAttribute("src", "data:,");
    await expect(preview.locator("h1")).not.toHaveCSS("color", "rgb(12, 100, 88)");
    await expect(document).toHaveAttribute("aria-busy", "false");
    const count = requests.length;
    await activate(page, page.getByRole("button", { name: "Refresh HTML preview" }));
    await page.evaluate(() => {
      const doc = (window as any).__oxbit.documents.get("resource-preview/index.html");
      doc.replace(doc.text.toString().replace("Trusted draft", "Revoked draft"));
    });
    await expect(preview.locator("h1")).toHaveText("Revoked draft");
    await expect(trust).toHaveValue("local");
    await expect(preview.getByAltText("Remote image", { exact: true })).toHaveAttribute("src", "data:,");
    expect(requests).toHaveLength(count);
    await activate(page, page.getByRole("button", { name: "Open source", exact: true }));
    await expect(page.locator(".cm-content")).toContainText("Revoked draft");
  });

  test("Markdown resource trust resolves local images and resets external access on reload", async ({ page }) => {
    const requests = await resources(page);
    await fixture(page, "md");
    await activate(page, page.getByRole("button", { name: "Open Markdown preview", exact: true }));
    const preview = page.getByRole("article", { name: "Markdown preview" });
    const trust = page.getByLabel("External resources", { exact: true });
    await expect(preview.getByRole("heading", { name: "Markdown resource trust" })).toBeVisible();
    await expect(trust).toHaveValue("local");
    await expect.poll(() => preview.getByAltText("Local image").evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(24);
    await expect(preview.getByAltText("Local image")).toHaveAttribute("src", /^data:image\/svg\+xml/);
    await expect(preview.getByAltText("Remote image")).toHaveAttribute("src", "data:,");
    expect(requests).toEqual([]);
    await phoneControls(page, page.locator(".markdown-document"));

    await trust.selectOption("external");
    await expect.poll(() => preview.getByAltText("Remote image").evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(24);
    expect(requests).toContain("/markdown.svg");
    await page.evaluate(() => {
      const doc = (window as any).__oxbit.documents.get("resource-preview/index.md");
      doc.replace(doc.text.toString().replace("Markdown resource trust", "Trusted Markdown draft"));
    });
    await expect(preview.getByRole("heading")).toHaveText("Trusted Markdown draft");
    await expect(trust).toHaveValue("external");
    await expect.poll(() => preview.getByAltText("Remote image").evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(24);

    await trust.selectOption("local");
    await expect(preview.getByAltText("Remote image")).toHaveAttribute("src", "data:,");
    const count = requests.length;
    await page.evaluate(() => {
      const doc = (window as any).__oxbit.documents.get("resource-preview/index.md");
      doc.replace(doc.text.toString().replace("Trusted Markdown draft", "Revoked Markdown draft"));
    });
    await expect(preview.getByRole("heading")).toHaveText("Revoked Markdown draft");
    await expect(preview.getByAltText("Remote image")).toHaveAttribute("src", "data:,");
    expect(requests).toHaveLength(count);

    await trust.selectOption("external");
    await expect.poll(() => preview.getByAltText("Remote image").evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(24);
    await page.evaluate(async () => {
      const app = (window as any).__oxbit;
      await app.documents.persist();
      await app.workbench.persist();
    });
    requests.length = 0;
    await page.reload();
    await page.waitForFunction(() => (window as any).__oxbit?.ready === true);
    const closePanel = page.locator(".bottom-panel").getByRole("button", { name: "Close panel", exact: true }).first();
    if (await closePanel.isVisible()) await activate(page, closePanel);
    await expect(preview.getByRole("heading")).toHaveText("Revoked Markdown draft");
    await expect(trust).toHaveValue("local");
    await expect(preview.getByAltText("Remote image")).toHaveAttribute("src", "data:,");
    expect(requests).toEqual([]);
    await activate(page, page.getByRole("button", { name: "Open source", exact: true }));
    await expect(page.locator(".cm-content")).toContainText("Revoked Markdown draft");
    await activate(page, page.getByRole("button", { name: "Open Markdown preview", exact: true }));
    await expect(preview.getByRole("heading")).toHaveText("Revoked Markdown draft");
    await expect(trust).toHaveValue("local");
  });
}
