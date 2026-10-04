import { chromium } from "@playwright/test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sourceDir = join(root, "design/releases/v0.3.1");
export const slides = [
  { id: "01-editor", title: "A real editor.\nIn your pocket.", tabletTitle: "A real editor.\nRoom to create.", caption: "Your code, wherever you are.", tone: "dark" },
  { id: "02-files", title: "Your files.\nRight at hand.", caption: "Open a project from the Files app.", tone: "light" },
  { id: "03-html-preview", title: "Write a page.\nSee it take shape.", caption: "Preview your HTML and CSS together.", tone: "dark" },
  { id: "04-markdown", title: "From plain text\nto a clearer view.", caption: "Read your Markdown as you write.", tone: "light" },
  { id: "05-panels", title: "Your panels.\nOne tap away.", caption: "Find the right view and get back to work.", tone: "dark" },
];
export const screenshotSets = [
  { id: "iphone-6.9", device: "iphone", width: 1320, height: 2868 },
  { id: "ipad-13", device: "ipad", width: 2064, height: 2752 },
];

export function pngDimensions(bytes) {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error("Expected a PNG image");
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), colorType: bytes[25] };
}

export function validateStoreCopy(copy) {
  for (const [field, limit] of Object.entries({ name: 30, subtitle: 30, promotionalText: 170, description: 4000, keywords: 100, whatsNew: 4000 })) {
    if (typeof copy[field] !== "string" || !copy[field].trim() || [...copy[field]].length > limit) {
      throw new Error(`Invalid App Store ${field}: maximum ${limit} characters`);
    }
  }
  for (const field of ["supportUrl", "marketingUrl"]) {
    if (new URL(copy[field]).protocol !== "https:") throw new Error(`Expected HTTPS ${field}`);
  }
  if (copy.privacyPolicyUrl && new URL(copy.privacyPolicyUrl).protocol !== "https:") throw new Error("Expected HTTPS privacyPolicyUrl");
}

export async function loadCaptures(directory, sets = screenshotSets, nativeCapture = true) {
  const captures = new Map();
  for (const set of sets) {
    const hashes = new Set();
    for (const slide of slides) {
      const path = join(directory, set.device, `${slide.id}.png`);
      const bytes = await readFile(path);
      const size = pngDimensions(bytes);
      if (size.width !== set.width || size.height !== set.height) throw new Error(`Incorrect capture dimensions: ${path}`);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (hashes.has(sha256)) throw new Error(`Duplicate capture: ${path}`);
      hashes.add(sha256);
      captures.set(`${set.device}/${slide.id}`, { bytes, path, sha256, nativeCapture });
    }
  }
  return captures;
}

const escape = text => String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
const dataUrl = (bytes, type = "image/png") => `data:${type};base64,${bytes.toString("base64")}`;
const brand = (await readFile(join(root, "apps/web/public/brand/oxbit-mark.svg"), "utf8"))
  .replace('width="64"', "").replace('height="64"', "").replaceAll("#8bd5ca", "currentColor");

function page(body, styles, fonts) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Oxbit release artwork</title><style>
@font-face{font-family:Instrument;src:url(${fonts.regular});font-weight:400}@font-face{font-family:Instrument;src:url(${fonts.semibold});font-weight:600}
*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden}body{font-family:Instrument,system-ui,sans-serif;background:#14161a;color:#f2f3ef;-webkit-font-smoothing:antialiased}
.brand{display:flex;align-items:center;gap:14px;font-size:34px;font-weight:600;letter-spacing:-.04em}.brand svg{width:46px;height:46px;color:#8bd5ca}h1,h2,p{margin:0}h1{font-weight:600;letter-spacing:-.055em;white-space:pre-line}img{display:block}.frame{border:2px solid #ffffff26;border-radius:28px;overflow:hidden;background:#14161a;box-shadow:0 24px 70px #0003}.frame img{width:100%;height:100%;object-fit:contain}.tag{font-size:25px;color:#a8b6b4;letter-spacing:.02em}${styles}
</style></head><body>${body}</body></html>`;
}

function screenshot(slide, set, capture, fonts, draft) {
  const tablet = set.device === "ipad";
  const dark = slide.tone === "dark";
  const padding = tablet ? 140 : 108;
  const shotHeight = tablet ? 1970 : 2110;
  const shotWidth = Math.round(shotHeight * set.width / set.height);
  const title = tablet && slide.tabletTitle ? slide.tabletTitle : slide.title;
  const label = `${tablet ? "iPad" : "iPhone & iPad"}${draft ? " · Browser draft" : ""}`;
  const body = `<main class="art"><header><div class="brand">${brand}Oxbit</div><span class="tag">${label}</span></header><h1>${escape(title)}</h1><p>${escape(slide.caption)}</p><div class="frame" style="width:${shotWidth}px;height:${shotHeight}px"><img src="${dataUrl(capture.bytes)}" alt="${escape(slide.caption)}"></div><footer><span>Code. On your terms.</span><span>${String(slides.indexOf(slide) + 1).padStart(2, "0")} / 05</span></footer></main>`;
  return page(body, `.art{width:100%;height:100%;padding:76px ${padding}px 48px;background:${dark ? "#14161a" : "#f2f3ef"};color:${dark ? "#f2f3ef" : "#14161a"}}header{display:flex;align-items:center;justify-content:space-between}h1{font-size:${tablet ? 124 : 110}px;line-height:1.04;margin-top:80px}p{font-size:${tablet ? 44 : 38}px;line-height:1.35;margin-top:28px;color:${dark ? "#b2bdbc" : "#596562"}}.frame{margin:68px auto 0}footer{display:flex;justify-content:space-between;margin-top:50px;font-size:25px;color:${dark ? "#a8b6b4" : "#596562"}}${dark ? "" : ".brand svg{color:#0f7b6c}.tag{color:#596562}.frame{border-color:#14161a22}"}`, fonts);
}

function banner(width, height, fonts) {
  const scale = width / 2400;
  const body = `<main class="promo"><div class="copy"><div class="brand">${brand}Oxbit</div><div class="tag">v0.3.1 · iPhone & iPad</div><h1>One editor.\nEvery screen.</h1><p>A real editor in your pocket.<br>Edit, preview, and keep your files close.</p><div class="end">Free and open source <span>oxbit.dev</span></div></div><div class="showcase"><div class="grid-art"></div><div class="hero-mark">${brand}</div><span class="corner">Code. On your terms.</span></div></main>`;
  return page(body, `.promo{position:absolute;inset:0;width:2400px;height:${height / scale}px;transform:scale(${scale});transform-origin:top left;background:radial-gradient(ellipse at 84% 50%,#25403b 0%,transparent 57%),#14161a;display:grid;grid-template-columns:1fr 1fr;align-items:center;padding:100px 120px;gap:80px}.brand{font-size:55px;gap:20px}.brand svg{width:72px;height:72px}.tag{margin-top:40px;font-size:28px}h1{font-size:122px;line-height:1.03;margin-top:35px}p{font-size:35px;line-height:1.5;color:#b2bdbc;margin-top:30px}.end{margin-top:62px;color:#8bd5ca;font-size:28px;display:flex;gap:50px}.end span{color:#b2bdbc}.showcase{height:100%;position:relative;display:grid;place-items:center}.hero-mark{width:800px;height:800px;color:#8bd5ca;position:relative}.hero-mark svg{width:100%;height:100%}.grid-art{position:absolute;width:900px;height:900px;background-image:linear-gradient(#8bd5ca12 1px,transparent 1px),linear-gradient(90deg,#8bd5ca12 1px,transparent 1px);background-size:100px 100px;mask-image:radial-gradient(ellipse,black 35%,transparent 75%)}.corner{position:absolute;bottom:80px;right:55px;color:#a8b6b4;font-size:25px;letter-spacing:.025em}`, fonts);
}

async function main() {
  const version = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;
  if (version !== "0.3.1") throw new Error(`Artwork targets 0.3.1; package version is ${version}`);
  const copy = JSON.parse(await readFile(join(sourceDir, "store-copy.json"), "utf8"));
  validateStoreCopy(copy);
  const promoOnly = process.argv.includes("--promo-only");
  const draft = process.argv.includes("--draft-captures");
  const review = process.argv.includes("--review");
  if ([promoOnly, draft, review].filter(Boolean).length > 1) throw new Error("Choose --promo-only, --draft-captures, or --review");
  const captureDirectories = promoOnly ? [] : review ? ["captures", "draft-captures"] : [draft ? "draft-captures" : "captures"];
  const provenancePaths = captureDirectories.map(directory => `${directory}/provenance.json`);
  const evidence = await Promise.all(provenancePaths.map(async path => JSON.parse(await readFile(join(sourceDir, path), "utf8"))));
  if (!promoOnly && !draft && evidence[0].nativeCapture !== true) throw new Error("Native capture evidence required");
  if ((draft || review) && evidence.at(-1).nativeCapture !== false) throw new Error("Browser draft evidence required");
  const provenance = promoOnly ? null : review ? { native: evidence[0], browser: evidence[1] } : evidence[0];
  const captures = promoOnly ? new Map() : review ? new Map([
    ...await loadCaptures(join(sourceDir, "captures"), [screenshotSets[0]]),
    ...await loadCaptures(join(sourceDir, "draft-captures"), [screenshotSets[1]], false),
  ]) : await loadCaptures(join(sourceDir, captureDirectories[0]), screenshotSets, !draft);
  const fonts = { regular: dataUrl(await readFile(join(root, "apps/web/public/fonts/oxbit-font-0.woff2")), "font/woff2"), semibold: dataUrl(await readFile(join(root, "apps/web/public/fonts/oxbit-font-2.woff2")), "font/woff2") };
  const artifacts = [];
  for (const appearance of ["default", "dark", "tinted"]) {
    const path = `icons/oxbit-ios-${appearance}.png`;
    const bytes = await readFile(join(sourceDir, path));
    const { width, height } = pngDimensions(bytes);
    artifacts.push({ path, width, height, format: "PNG RGB", appearance, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  await mkdir(join(sourceDir, "licenses"), { recursive: true });
  for (const [source, name] of [["apps/web/public/fonts/instrumentsans-OFL.txt", "InstrumentSans-OFL.txt"], ["LICENSE", "Oxbit-MIT.txt"]]) {
    await writeFile(join(sourceDir, "licenses", name), await readFile(join(root, source)));
  }
  const browser = await chromium.launch();
  try {
    const renderPage = await browser.newPage({ deviceScaleFactor: 1 });
    const exportPage = async (path, html, width, height, details) => {
      await renderPage.setViewportSize({ width, height });
      await renderPage.setContent(html);
      await renderPage.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all([...document.images].map(image => image.decode()));
        for (const element of document.querySelectorAll("h1,p,.frame,footer")) {
          const box = element.getBoundingClientRect();
          if (box.bottom > innerHeight || box.right > innerWidth || box.x < 0 || box.y < 0) throw new Error("Artwork extends beyond the canvas");
        }
      });
      const png = await renderPage.screenshot({ type: "png", omitBackground: false });
      const size = pngDimensions(png);
      if (size.width !== width || size.height !== height || size.colorType !== 2) throw new Error(`Invalid opaque RGB export: ${path}`);
      await mkdir(dirname(join(sourceDir, path)), { recursive: true });
      await writeFile(join(sourceDir, path), png);
      await writeFile(join(sourceDir, path.replace(/\.png$/, ".html")), html);
      artifacts.push({ path, width, height, format: "PNG RGB", bytes: png.length, sha256: createHash("sha256").update(png).digest("hex"), ...details });
    };
    for (const set of promoOnly ? [] : screenshotSets) {
      for (const slide of slides) {
        const capture = captures.get(`${set.device}/${slide.id}`);
        const screenshotDirectory = capture.nativeCapture ? "screenshots" : "draft-screenshots";
        const title = set.device === "ipad" && slide.tabletTitle ? slide.tabletTitle : slide.title;
        await exportPage(`${screenshotDirectory}/${set.id}/${slide.id}.png`, screenshot(slide, set, capture, fonts, !capture.nativeCapture), set.width, set.height, { source: relative(sourceDir, capture.path), sourceSha256: capture.sha256, nativeCapture: capture.nativeCapture, title });
      }
    }
    for (const [name, width, height] of [["promo-banner", 2400, 1260], ["social-card", 1200, 630]]) {
      await exportPage(`promo/${name}.png`, banner(width, height, fonts), width, height, { purpose: name });
    }
  } finally {
    await browser.close();
  }
  const screenshotStatus = promoOnly ? "Icons and promo graphics; native screenshots pending." : review ? "Native iPhone screenshots and browser iPad drafts; native iPad capture pending." : draft ? "Browser drafts; native capture pending." : "Native app captures and App Store screenshots included.";
  const bundle = { version, generatedAt: new Date().toISOString(), inspiration: "https://ryanyannelli.com/projects/oxbit/", screenshotStatus, provenance, artifacts };
  await writeFile(join(sourceDir, "manifest.json"), `${JSON.stringify(bundle, null, 2)}\n`);
  const preview = await contactSheet(artifacts, provenancePaths, screenshotStatus);
  await writeFile(join(sourceDir, "index.html"), preview);
  const output = join(root, "release/v0.3.1");
  await mkdir(output, { recursive: true });
  const archive = join(output, `oxbit-v0.3.1-${promoOnly ? "brand" : draft || review ? "review" : "ios"}-artwork.zip`);
  const files = ["icons", "licenses", "sample-workspace", "store-copy.json", "manifest.json", "index.html", ...provenancePaths];
  for (const artifact of artifacts.filter(item => !item.path.startsWith("icons/"))) files.push(artifact.path, artifact.path.replace(/\.png$/, ".html"));
  for (const capture of captures.values()) files.push(relative(sourceDir, capture.path));
  await rm(archive, { force: true });
  execFileSync("zip", ["-q", "-r", archive, ...files, "-x", "*.DS_Store"], { cwd: sourceDir });
  console.log(`Exported ${artifacts.length} graphics and ${relative(root, archive)}`);
}

async function contactSheet(artifacts, provenancePaths, screenshotStatus) {
  const screenshots = artifacts.filter(item => item.path.includes("screenshots/"));
  const promos = artifacts.filter(item => item.path.startsWith("promo/"));
  const icons = (await readdir(join(sourceDir, "icons"))).filter(name => name.endsWith(".png"));
  const summary = screenshotStatus;
  const evidence = provenancePaths.map(path => ` · <a href="${path}">${path.startsWith("draft-") ? "Browser" : "Native"} capture evidence</a>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Oxbit v0.3.1 release artwork</title><style>body{margin:0;background:#14161a;color:#f2f3ef;font-family:system-ui,sans-serif;padding:36px}main{max-width:1400px;margin:auto}h1{font-size:42px;letter-spacing:-.04em}p{color:#b2bdbc;line-height:1.6}a{color:#8bd5ca}img{display:block;max-width:100%;height:auto}section{margin:48px 0}.icons{display:flex;gap:24px;flex-wrap:wrap}.icons figure{width:180px}.icons img{border-radius:32px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:20px}figure{margin:0}figcaption{font-size:13px;line-height:1.7;margin-top:12px}h2{font-weight:500}.promo{max-width:1000px;margin-bottom:24px}.button{display:inline-block;background:#8bd5ca;color:#14161a;padding:14px 20px;border-radius:8px;text-decoration:none}@media(max-width:600px){body{padding:20px}h1{font-size:32px}.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}</style></head><body><main><h1>Oxbit v0.3.1</h1><p>iOS release artwork. ${summary}</p><a href="store-copy.json">App Store copy</a> · <a href="manifest.json">Export manifest</a>${evidence}<section><h2>App icon appearances</h2><div class="icons">${icons.map(name => `<figure><a href="icons/${escape(name)}" download><img src="icons/${escape(name)}" alt="${escape(name)}"></a><figcaption>${escape(name)}</figcaption></figure>`).join("")}</div></section>${screenshotSets.filter(set => screenshots.some(item => item.path.includes(set.id))).map(set => `<section><h2>${set.id} · ${set.width} × ${set.height}</h2><div class="grid">${screenshots.filter(item => item.path.includes(set.id)).map(item => `<figure><a href="${item.path}" download><img src="${item.path}" alt="${escape(item.title)}"></a><figcaption>${escape(item.title).replaceAll("\n", " ")}</figcaption></figure>`).join("")}</div></section>`).join("")}<section><h2>Promo graphics</h2>${promos.map(item => `<figure class="promo"><a href="${item.path}" download><img src="${item.path}" alt="Oxbit promo"></a><figcaption>${item.width} × ${item.height}</figcaption></figure>`).join("")}</section></main></body></html>\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
