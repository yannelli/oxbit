import { chromium } from "@playwright/test";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32 } from "node:zlib";
import { brand, dataUrl, escape, page, pngDimensions } from "./render-release-assets.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const release = join(root, "design/releases/v0.13.0");
const slides = [
  { id: "01-ai-completion", title: "Code that\nfinishes itself.", tabletTitle: "Code that finishes\nitself. Side by side.", caption: "AI suggestions appear as you type.", tone: "dark" },
  { id: "02-agent", title: "An agent\nfor your project.", caption: "It reads, edits, and waits for your review.", tone: "light" },
  { id: "03-ai-models", title: "Pick a model.\nSee the price.", caption: "Suggested models with price, context, and score.", tone: "dark" },
  { id: "04-source-control", title: "Commit from\nanywhere.", caption: "Stage changes and write the message.", tone: "light" },
  { id: "05-html-preview", title: "Write a page.\nSee it take shape.", caption: "Preview your HTML and CSS.", tabletCaption: "Edit the source and preview it side by side.", tone: "dark" },
  { id: "06-workspaces", title: "Your folders.\nYour servers.", caption: "Open local folders, runtimes, and SSH hosts.", tone: "light" },
];
const sets = [
  { id: "iphone-6.9", device: "iphone", width: 1320, height: 2868 },
  { id: "iphone-6.3", device: "iphone-6.3", width: 1206, height: 2622 },
  { id: "ipad-13", device: "ipad", width: 2064, height: 2752 },
];
const promos = [
  { name: "promo-banner", width: 2400, height: 1260 },
  { name: "social-card", width: 1200, height: 630 },
  { name: "product-page-header", width: 3840, height: 1646 },
  { name: "search-results", width: 1920, height: 1280 },
];

/** Adds an sRGB chunk after IHDR so the PNG states its color space. */
function withSrgb(png) {
  const chunk = Buffer.alloc(13);
  chunk.writeUInt32BE(1, 0);
  chunk.write("sRGB", 4, "latin1");
  chunk[8] = 0;
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 9)), 9);
  return Buffer.concat([png.subarray(0, 33), chunk, png.subarray(33)]);
}

const wifi = `<svg viewBox="0 0 17 12" aria-hidden="true"><path fill="currentColor" d="M8.5 2.4c2.4 0 4.6.9 6.3 2.5l1.2-1.2C14 1.8 11.4.7 8.5.7S3 1.8 1 3.7l1.2 1.2C3.9 3.3 6.1 2.4 8.5 2.4Zm0 3.4c1.5 0 2.8.6 3.9 1.5l1.2-1.2A7.5 7.5 0 0 0 8.5 4c-2 0-3.8.8-5.1 2.1l1.2 1.2c1-.9 2.4-1.5 3.9-1.5Zm0 3.4c.6 0 1.2.2 1.6.6L8.5 11.5 6.9 9.8c.4-.4 1-.6 1.6-.6Z"/></svg>`;
const battery = `<svg viewBox="0 0 28 13" aria-hidden="true"><rect x=".5" y=".5" width="24" height="12" rx="3.8" fill="none" stroke="currentColor" opacity=".4"/><rect x="2" y="2" width="21" height="9" rx="2.5" fill="currentColor"/><path d="M26 4.5v4c.8-.3 1.3-1.1 1.3-2s-.5-1.7-1.3-2Z" fill="currentColor" opacity=".4"/></svg>`;

/** The device screen: status bar, app capture, and home indicator strip, colored from the capture's edge pixels. */
function deviceScreen(set, capture, scale, alt) {
  const { top, bottom } = capture.insets;
  const tablet = set.device === "ipad";
  const time = tablet ? `9:41 AM<span class="date">Mon Oct 19</span>` : "9:41";
  return `<div class="screen" style="--s:${scale}"><div class="status ${tablet ? "tablet" : "phone"}" style="height:${top * scale}px"><span class="time">${time}</span><span class="icons">${wifi}${battery}</span></div><img src="${dataUrl(capture.bytes)}" alt="${escape(alt)}"><div class="home" style="height:${bottom * scale}px"><i></i></div></div>`;
}

const screenStyles = `.screen{display:flex;flex-direction:column;width:100%;height:100%;font-family:-apple-system,"SF Pro Text",system-ui,sans-serif}.screen img{width:100%;height:auto;flex:none}.status{flex:none;display:flex;align-items:center;justify-content:space-between;color:var(--ink,#fff);font-weight:600;letter-spacing:-.01em}.status.phone{padding:calc(var(--s)*18px) calc(var(--s)*34px) 0 calc(var(--s)*52px);font-size:calc(var(--s)*17px)}.status.tablet{padding:0 calc(var(--s)*20px);font-size:calc(var(--s)*12px)}.status .date{margin-left:calc(var(--s)*6px)}.icons{display:flex;align-items:center;gap:calc(var(--s)*6px)}.icons svg:first-child{width:calc(var(--s)*17px);height:calc(var(--s)*12px)}.icons svg:last-child{width:calc(var(--s)*27px);height:calc(var(--s)*13px)}.home{flex:1 0 auto;display:flex;align-items:flex-end;justify-content:center;padding-bottom:calc(var(--s)*8px)}.home i{display:block;width:calc(var(--s)*${139}px);height:calc(var(--s)*5px);border-radius:99px;background:var(--pill,#fff)}.tabletframe .home i{width:calc(var(--s)*315px)}`;
const sampleScript = `<script>(async()=>{const img=document.querySelector(".screen img");await img.decode();const c=document.createElement("canvas");c.width=img.naturalWidth;c.height=img.naturalHeight;const x=c.getContext("2d");x.drawImage(img,0,0);const at=y=>{const [r,g,b]=x.getImageData(2,y,1,1).data;return{color:\`rgb(\${r},\${g},\${b})\`,dark:.2126*r+.7152*g+.0722*b<140}};const t=at(1),b=at(c.height-2);const s=document.querySelector(".status"),h=document.querySelector(".home");s.style.background=t.color;s.style.setProperty("--ink",t.dark?"#fff":"#000");h.style.background=b.color;h.style.setProperty("--pill",b.dark?"#fff":"#000");document.body.dataset.ready="true"})()</script>`;

function screenshot(slide, set, capture, fonts, index) {
  const tablet = set.device === "ipad";
  const k = set.width / (tablet ? 2064 : 1320);
  const px = value => Math.round(value * k);
  const dark = slide.tone === "dark";
  const shotHeight = px(tablet ? 1970 : 2110);
  const shotWidth = Math.round(shotHeight * set.width / set.height);
  const title = tablet && slide.tabletTitle ? slide.tabletTitle : slide.title;
  const caption = tablet && slide.tabletCaption ? slide.tabletCaption : slide.caption;
  const scale = (shotWidth - 4) / capture.viewport[0];
  const body = `<main class="art"><header><div class="brand">${brand}Oxbit</div><span class="tag">${tablet ? "iPad" : "iPhone & iPad"}</span></header><h1>${escape(title)}</h1><p>${escape(caption)}</p><div class="frame ${tablet ? "tabletframe" : ""}" style="width:${shotWidth}px;height:${shotHeight}px">${deviceScreen(set, capture, scale, caption)}</div><footer><span>Code. On your terms.</span><span>${String(index + 1).padStart(2, "0")} / ${String(slides.length).padStart(2, "0")}</span></footer></main>${sampleScript}`;
  return page(body, `${screenStyles}.art{width:100%;height:100%;padding:${px(76)}px ${px(tablet ? 140 : 108)}px ${px(48)}px;background:${dark ? "#14161a" : "#f2f3ef"};color:${dark ? "#f2f3ef" : "#14161a"}}header{display:flex;align-items:center;justify-content:space-between}.brand{font-size:${px(34)}px;gap:${px(14)}px}.brand svg{width:${px(46)}px;height:${px(46)}px}.tag{font-size:${px(25)}px}h1{font-size:${px(tablet ? 124 : 110)}px;line-height:1.04;margin-top:${px(80)}px}p{font-size:${px(tablet ? 44 : 38)}px;line-height:1.35;margin-top:${px(28)}px;color:${dark ? "#b2bdbc" : "#596562"}}.frame{margin:${px(68)}px auto 0;border-radius:${px(28)}px}footer{display:flex;justify-content:space-between;margin-top:${px(50)}px;font-size:${px(25)}px;color:${dark ? "#a8b6b4" : "#596562"}}${dark ? "" : ".brand svg{color:#0f7b6c}.tag{color:#596562}.frame{border-color:#14161a22}"}`, fonts);
}

function promo({ width, height }, fonts) {
  const scale = width / 2400;
  const tall = height / scale;
  const body = `<main class="promo"><div class="copy"><div class="brand">${brand}Oxbit</div><div class="tag">v0.13.0 · iPhone & iPad</div><h1>Code with AI.\nAnywhere.</h1><p>Inline AI completions and an in-app agent.<br>Edit, preview, and commit on the go.</p><div class="end">Free and open source <span>oxbit.dev</span></div></div><div class="showcase"><div class="grid-art"></div><div class="hero-mark">${brand}</div><span class="corner">Code. On your terms.</span></div></main><script>document.body.dataset.ready="true"</script>`;
  const mark = Math.min(800, tall - 260);
  return page(body, `.promo{position:absolute;inset:0;width:2400px;height:${tall}px;transform:scale(${scale});transform-origin:top left;background:radial-gradient(ellipse at 84% 50%,#25403b 0%,transparent 57%),#14161a;display:grid;grid-template-columns:1fr 1fr;align-items:center;padding:100px 120px;gap:80px}.brand{font-size:55px;gap:20px}.brand svg{width:72px;height:72px}.tag{margin-top:40px;font-size:28px}h1{font-size:122px;line-height:1.03;margin-top:35px}p{font-size:35px;line-height:1.5;color:#b2bdbc;margin-top:30px}.end{margin-top:62px;color:#8bd5ca;font-size:28px;display:flex;gap:50px}.end span{color:#b2bdbc}.showcase{height:100%;position:relative;display:grid;place-items:center}.hero-mark{width:${mark}px;height:${mark}px;color:#8bd5ca;position:relative}.hero-mark svg{width:100%;height:100%}.grid-art{position:absolute;width:${mark + 100}px;height:${mark + 100}px;background-image:linear-gradient(#8bd5ca12 1px,transparent 1px),linear-gradient(90deg,#8bd5ca12 1px,transparent 1px);background-size:100px 100px;mask-image:radial-gradient(ellipse,black 35%,transparent 75%)}.corner{position:absolute;bottom:${Math.min(80, (tall - mark) / 4)}px;right:55px;color:#a8b6b4;font-size:25px;letter-spacing:.025em}`, fonts);
}

/** iPhone crops about 300 px from each side and iPad about 250 px from the top and bottom, with navigation over the top band (App Store previews, 2026-10-19). */
const headerSafe = { x: 760, y: 520, width: 2320, height: 820 };

function productPageHeader(fonts) {
  const { x, y, width, height } = headerSafe;
  const mark = 700;
  const body = `<main class="header"><div class="grid-art"></div><div class="safe"><div class="copy"><h1>Code with AI.\nAnywhere.</h1><p>Completions, an agent, Git, and SSH<br>on your iPhone and iPad.</p></div><div class="hero-mark">${brand}</div></div></main><script>document.body.dataset.ready="true"</script>`;
  return page(body, `.header{position:absolute;inset:0;background:radial-gradient(ellipse at 66% 56%,#25403b 0%,transparent 45%),#14161a}.grid-art{position:absolute;inset:0;background-image:linear-gradient(#8bd5ca10 1px,transparent 1px),linear-gradient(90deg,#8bd5ca10 1px,transparent 1px);background-size:120px 120px;mask-image:radial-gradient(ellipse at 66% 56%,black 20%,transparent 60%)}.safe{position:absolute;left:${x}px;top:${y}px;width:${width}px;height:${height}px;display:flex;align-items:center;justify-content:space-between}h1{font-size:184px;line-height:1.02}p{font-size:58px;line-height:1.4;color:#b2bdbc;margin-top:48px}.hero-mark{width:${mark}px;height:${mark}px;flex:none;color:#8bd5ca}.hero-mark svg{width:100%;height:100%}`, fonts);
}

async function main() {
  const version = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;
  if (version !== "0.13.0") throw new Error(`Artwork targets 0.13.0; package version is ${version}`);
  const provenance = JSON.parse(await readFile(join(release, "provenance.json"), "utf8"));
  const captures = new Map();
  for (const set of sets) for (const slide of slides) {
    const entry = provenance.captures.find(item => item.device === set.device && item.state === slide.id);
    const device = provenance.devices.find(item => item.name === set.device);
    if (!entry || !device) throw new Error(`Missing capture: ${set.device}/${slide.id}`);
    const bytes = await readFile(join(release, entry.path));
    const size = pngDimensions(bytes);
    if (size.width !== entry.width || size.height !== entry.height) throw new Error(`Incorrect capture dimensions: ${entry.path}`);
    if (Math.abs(device.screen[0] / device.screen[1] - set.width / set.height) > 0.001) throw new Error(`Aspect mismatch: ${set.id}`);
    captures.set(`${set.device}/${slide.id}`, { bytes, path: entry.path, viewport: device.viewport, insets: device.insets, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  const fonts = { regular: dataUrl(await readFile(join(root, "apps/web/public/fonts/oxbit-font-0.woff2")), "font/woff2"), semibold: dataUrl(await readFile(join(root, "apps/web/public/fonts/oxbit-font-2.woff2")), "font/woff2") };
  const artifacts = [];
  const icon = await readFile(join(root, "design/releases/v0.3.1/icons/oxbit-ios-default.png"));
  const iconSize = pngDimensions(icon);
  if (iconSize.width !== 1024 || iconSize.height !== 1024 || iconSize.colorType !== 2) throw new Error("App Store icon must be 1024 × 1024 RGB without alpha");
  await mkdir(join(release, "icons"), { recursive: true });
  await copyFile(join(root, "design/releases/v0.3.1/icons/oxbit-ios-default.png"), join(release, "icons/oxbit-ios-default.png"));
  artifacts.push({ path: "icons/oxbit-ios-default.png", width: 1024, height: 1024, colorType: 2, bytes: icon.length, sha256: createHash("sha256").update(icon).digest("hex"), source: "design/releases/v0.3.1/icons/oxbit-ios-default.png" });
  const browser = await chromium.launch();
  try {
    const renderPage = await browser.newPage({ deviceScaleFactor: 1 });
    const exportPage = async (path, html, width, height, details) => {
      await renderPage.setViewportSize({ width, height });
      await renderPage.setContent(html);
      await renderPage.waitForFunction(() => document.body.dataset.ready === "true");
      await renderPage.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all([...document.images].map(image => image.decode()));
        for (const element of document.querySelectorAll("h1,p,.frame,footer,.copy,.hero-mark")) {
          const box = element.getBoundingClientRect();
          if (box.bottom > innerHeight + 0.5 || box.right > innerWidth + 0.5 || box.x < 0 || box.y < 0) throw new Error(`Artwork extends beyond the canvas: ${element.tagName}.${element.className}`);
        }
        const safe = document.querySelector(".safe")?.getBoundingClientRect();
        if (safe) for (const element of document.querySelectorAll(".safe h1,.safe p,.safe .hero-mark")) {
          const box = element.getBoundingClientRect();
          if (box.x < safe.x || box.y < safe.y || box.right > safe.right + 0.5 || box.bottom > safe.bottom + 0.5) throw new Error(`Artwork extends beyond the safe area: ${element.tagName}.${element.className}`);
        }
      });
      const png = withSrgb(await renderPage.screenshot({ type: "png", omitBackground: false }));
      const size = pngDimensions(png);
      if (size.width !== width || size.height !== height || size.colorType !== 2) throw new Error(`Invalid opaque RGB export: ${path}`);
      if (png.length >= 10 * 1024 * 1024) throw new Error(`Export over 10 MB: ${path}`);
      await mkdir(dirname(join(release, path)), { recursive: true });
      await writeFile(join(release, path), png);
      await writeFile(join(release, path.replace(/\.png$/, ".html")), html);
      artifacts.push({ path, width, height, colorType: size.colorType, colorSpace: "sRGB", bytes: png.length, sha256: createHash("sha256").update(png).digest("hex"), ...details });
    };
    for (const set of sets) for (const [index, slide] of slides.entries()) {
      const capture = captures.get(`${set.device}/${slide.id}`);
      await exportPage(`screenshots/${set.id}/${slide.id}.png`, screenshot(slide, set, capture, fonts, index), set.width, set.height,
        { source: capture.path, sourceSha256: capture.sha256, title: set.device === "ipad" && slide.tabletTitle ? slide.tabletTitle : slide.title });
    }
    for (const item of promos) await exportPage(`promo/${item.name}.png`, item.name === "product-page-header" ? productPageHeader(fonts) : promo(item, fonts), item.width, item.height, { purpose: item.name });
  } finally {
    await browser.close();
  }
  const manifest = { version, generatedAt: new Date().toISOString(), screenshotSource: provenance.source, browserEngine: provenance.browserEngine, renderer: "Chromium (Playwright) at 1x for the marketing frame", provenance: "provenance.json", artifacts };
  await writeFile(join(release, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(release, "index.html"), contactSheet(artifacts));
  console.log(`Exported ${artifacts.length} graphics to ${release}`);
}

function contactSheet(artifacts) {
  const figure = item => `<figure><a href="${item.path}" download><img src="${item.path}" alt="${escape(item.title ?? item.purpose ?? item.path)}"></a><figcaption>${escape((item.title ?? item.path).replaceAll("\n", " "))} · ${item.width} × ${item.height}</figcaption></figure>`;
  const sections = sets.map(set => `<section><h2>${set.id} · ${set.width} × ${set.height}</h2><div class="grid">${artifacts.filter(item => item.path.startsWith(`screenshots/${set.id}/`)).map(figure).join("")}</div></section>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Oxbit v0.13.0 App Store artwork</title><style>body{margin:0;background:#14161a;color:#f2f3ef;font-family:system-ui,sans-serif;padding:36px}main{max-width:1400px;margin:auto}h1{font-size:42px;letter-spacing:-.04em}p{color:#b2bdbc;line-height:1.6}a{color:#8bd5ca}img{display:block;max-width:100%;height:auto}section{margin:48px 0}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:20px}figure{margin:0}figcaption{font-size:13px;line-height:1.7;margin-top:12px}.wide{display:grid;gap:24px}.icon img{width:180px;border-radius:32px}</style></head><body><main><h1>Oxbit v0.13.0</h1><p>App Store screenshots framed from WebKit renders of the iOS frontend with the mocked native bridge. <a href="manifest.json">Export manifest</a> · <a href="provenance.json">Capture provenance</a></p><section class="icon"><h2>App icon</h2>${figure(artifacts[0])}</section>${sections}<section><h2>Promo graphics</h2><div class="wide">${artifacts.filter(item => item.path.startsWith("promo/")).map(figure).join("")}</div></section></main></body></html>\n`;
}

await main();
