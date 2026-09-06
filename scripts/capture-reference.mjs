import { chromium } from "@playwright/test";
import http from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
const root = path.resolve("design/reference");
const server = http.createServer(async (req, res) => {
  try {
    const filename = path.resolve(
      root,
      "." + decodeURIComponent(new URL(req.url, "http://localhost").pathname),
    );
    if (!filename.startsWith(root + path.sep)) throw new Error("Invalid path");
    const data = await readFile(filename);
    res.setHeader(
      "Content-Type",
      filename.endsWith(".js")
        ? "text/javascript"
        : filename.endsWith(".html")
          ? "text/html"
          : "application/octet-stream",
    );
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const browser = await chromium.launch({ headless: true });
const evidence = [];
try {
  await mkdir("design/baselines", { recursive: true });
  for (const [name, width, height, viewport] of [
    ["desktop", 1440, 900, "desktop"],
    ["tablet-landscape", 1024, 768, "tabletL"],
    ["tablet-portrait", 768, 1024, "tabletP"],
    ["phone", 390, 844, "phone"],
  ])
    for (const theme of ["dark", "light"]) {
      const page = await browser.newPage({
        viewport: { width: width + 64, height: height + 64 },
        deviceScaleFactor: 1,
      });
      await page.goto(
        `http://127.0.0.1:${server.address().port}/Zapp%20Workbench.dc.html`,
      );
      await page.waitForFunction(() => window.__zapp?.F, { timeout: 30000 });
      await page.evaluate(
        ({ viewport, theme }) =>
          window.__zapp.setState(
            { viewport, theme, review: { open: false }, kbd: false },
            () => window.__zapp.measure(),
          ),
        { viewport, theme },
      );
      await page.waitForTimeout(500);
      const shell = page.locator('[data-screen-label="Workbench"]');
      const bounds = await shell.boundingBox();
      await shell.screenshot({ path: `design/baselines/${name}-${theme}.png` });
      evidence.push({
        name,
        theme,
        requested: { width, height },
        actual: bounds,
      });
      await page.close();
    }
  await writeFile(
    "design/baselines/dimensions.json",
    JSON.stringify(evidence, null, 2) + "\n",
  );
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
