import { chromium } from '@playwright/test';
import { mkdir, readFile, writeFile, mkdtemp, rm, copyFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Render the established outlined artwork directly; no fonts or image libraries needed.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = join(root, 'apps/web/public');
const brandDir = join(publicDir, 'brand');
const output = join(brandDir, 'variants');
const sizes = [16, 24, 32, 48, 64, 96, 128, 144, 152, 180, 192, 256, 384, 512, 1024, 2048];
const modes = [
  { id: 'dark', label: 'Dark', background: '#14161a', mark: '#8bd5ca', text: '#f2f3ef' },
  { id: 'light', label: 'Light', background: '#f2f3ef', mark: '#0f7b6c', text: '#14161a' },
  { id: 'dark-transparent', label: 'Dark (Transparent BG)', background: '#14161a', mark: '#8bd5ca', text: '#f2f3ef', transparent: true },
  { id: 'light-transparent', label: 'Light (Transparent BG)', background: '#f2f3ef', mark: '#0f7b6c', text: '#14161a', transparent: true },
];
const [logoSource, markSource, faviconSource] = await Promise.all([
  readFile(join(brandDir, 'oxbit-logo.svg'), 'utf8'),
  readFile(join(brandDir, 'oxbit-mark.svg'), 'utf8'),
  readFile(join(publicDir, 'favicon.svg'), 'utf8'),
]);
function artwork(source) {
  return source.replace(/^[\s\S]*?<\/title>/, '').replace(/<\/svg>\s*$/, '').replace(/<rect\b[^>]*\/>/g, '');
}
function svg(mode, type, square = false, opaque = false) {
  const width = type === 'full-logo' ? 560 : type === 'favicon' ? 16 : 64;
  const height = square ? width : type === 'full-logo' ? 160 : width;
  const source = type === 'full-logo' ? logoSource : type === 'favicon' ? faviconSource : markSource;
  const content = artwork(source).replaceAll('#8bd5ca', mode.mark).replaceAll('#f2f3ef', mode.text);
  const background = !mode.transparent || opaque ? `<rect width="${width}" height="${height}" fill="${mode.background}"/>` : '';
  const transform = square && type === 'full-logo' ? '<g transform="translate(0 200)">' : '<g>';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title"><title id="title">Oxbit ${type} — ${mode.label}</title>${background}${transform}${content}</g></svg>\n`;
}

const files = [];
async function save(path, data, details = {}) {
  const target = join(output, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, data);
  files.push({ path, ...details });
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  async function png(path, source, width, height, transparent) {
    const encoded = await page.evaluate(async ({ source, width, height, transparent }) => {
      const image = new Image();
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0, width, height);
      const pixels = context.getImageData(0, 0, width, height).data;
      let hasClearPixel = false;
      let hasVisiblePixel = false;
      for (let index = 3; index < pixels.length; index += 4) {
        if (pixels[index] === 0) hasClearPixel = true;
        if (pixels[index] > 0) hasVisiblePixel = true;
        if (!transparent && pixels[index] !== 255) throw new Error('Opaque export contains transparency');
      }
      if (!hasVisiblePixel || (transparent && !hasClearPixel)) throw new Error('Unexpected export alpha coverage');
      return canvas.toDataURL('image/png').split(',')[1];
    }, { source, width, height, transparent });
    const buffer = Buffer.from(encoded, 'base64');
    if (buffer.readUInt32BE(16) !== width || buffer.readUInt32BE(20) !== height) throw new Error(`Incorrect dimensions: ${path}`);
    await save(path, buffer, { width, height, transparent: Boolean(transparent) });
    return buffer;
  }

  for (const mode of modes) {
    for (const type of ['full-logo', 'logo-mark']) {
      const prefix = `${mode.id}/${type}/oxbit-${type}`;
      const source = svg(mode, type);
      await save(`${prefix}.svg`, source);
      const width = type === 'full-logo' ? 2240 : 1024;
      await png(`${prefix}.png`, source, width, type === 'full-logo' ? 640 : width, mode.transparent);
      if (type === 'full-logo') {
        for (const width of [560, 1120, 2240, 4480]) {
          await png(`${prefix}-${width}x${width * 2 / 7}.png`, source, width, width * 2 / 7, mode.transparent);
        }
        await save(`${mode.id}/${type}/square/oxbit-full-logo-square.svg`, svg(mode, type, true));
      }
      for (const size of sizes) {
        await png(`${mode.id}/${type}/${type === 'full-logo' ? 'square/' : ''}oxbit-${type}-${size}x${size}.png`, svg(mode, type, true), size, size, mode.transparent);
      }
    }

    const favicon = svg(mode, 'favicon');
    await save(`${mode.id}/browser/favicon.svg`, favicon);
    const frames = [];
    for (const size of [16, 32, 48]) {
      frames.push(await png(`${mode.id}/browser/favicon-${size}x${size}.png`, favicon, size, size, mode.transparent));
    }
    // ICO directory followed by lossless PNG frames, supported by modern browsers/Windows.
    const header = Buffer.alloc(6 + frames.length * 16);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(frames.length, 4);
    let offset = header.length;
    for (const [index, frame] of frames.entries()) {
      const entry = 6 + index * 16;
      header[entry] = frame.readUInt32BE(16);
      header[entry + 1] = frame.readUInt32BE(20);
      header.writeUInt16LE(1, entry + 4);
      header.writeUInt16LE(32, entry + 6);
      header.writeUInt32LE(frame.length, entry + 8);
      header.writeUInt32LE(offset, entry + 12);
      offset += frame.length;
    }
    await save(`${mode.id}/browser/favicon.ico`, Buffer.concat([header, ...frames]));
    for (const size of [120, 152, 167, 180]) {
      await png(`${mode.id}/browser/apple-touch-icon-${size}x${size}.png`, svg(mode, 'logo-mark', true, true), size, size, false);
    }
    await png(`${mode.id}/browser/apple-touch-icon.png`, svg(mode, 'logo-mark', true, true), 180, 180, false);
    console.log(`Rendered ${mode.label}`);
  }
} finally {
  await browser.close();
}

const readme = `# Oxbit logo exports

Generated from the existing outlined Oxbit SVGs. No font installation is required.

## Color modes

| Folder | Artwork | Background |
| --- | --- | --- |
| dark | Mint #8BD5CA mark, paper #F2F3EF lettering | Graphite #14161A |
| light | Teal #0F7B6C mark, graphite #14161A lettering | Paper #F2F3EF |
| dark-transparent | Same artwork as dark, for placement on dark surfaces | Transparent |
| light-transparent | Same artwork as light, for placement on light surfaces | Transparent |

Mode names describe the intended surface. The older parent-folder oxbit-logo-dark.svg name describes its dark lettering instead; these exports use explicit surface-based names.

## Contents of each mode

- full-logo/: independent SVG master (560 × 160), default PNG (2240 × 640), and horizontal PNGs at 560 × 160, 1120 × 320, 2240 × 640, and 4480 × 1280.
- full-logo/square/: centered, undistorted horizontal logo on a square canvas, with its own SVG and all square PNG sizes.
- logo-mark/: independent SVG master (64 × 64), default PNG (1024 × 1024), and all square PNG sizes.
- browser/: small-size optimized favicon SVG, 16/32/48px PNGs, multi-resolution ICO with all three sizes, and Apple Touch Icons at 120/152/167/180px. apple-touch-icon.png is the 180px default.

Square PNG sizes: ${sizes.map(size => `${size} × ${size}`).join(', ')}.

Use the logo mark for small application icons; the full logo is supplied in square form for completeness but its wordmark is not legible at favicon sizes. Favicons retain the existing optically adjusted small-size geometry. All other exports preserve the original logo geometry and clear space. Opaque backgrounds fill the canvas without pre-rounded corners.

Apple Touch Icons intentionally have an opaque matching background in every mode, including the transparent folders. Use the regular logo-mark PNGs when actual transparency is needed. Platform launch icons use the mark, whose square layout is appropriate for these surfaces.

Open index.html for previews and individual downloads. The parent oxbit-brand-kit.zip includes this complete collection plus the original assets. manifest.json lists every rendered asset, including PNG dimensions and transparency.

## Regenerate

From the repository root, run \`node scripts/render-brand-assets.mjs\`. Requires the existing @playwright/test dependency, its Chromium browser (\`bunx playwright install chromium\`), and the system zip command. PNG dimensions and alpha coverage are checked during rendering. The script also rebuilds the full brand-kit ZIP.
`;
await writeFile(join(output, 'README.md'), readme);
await writeFile(join(output, 'manifest.json'), JSON.stringify({ squareSizes: sizes, modes, assets: files }, null, 2) + '\n');

function downloads(mode, type) {
  const prefix = `${mode.id}/${type}/oxbit-${type}`;
  return `<div class="links"><a href="${prefix}.png" download>PNG</a><a href="${prefix}.svg" download>SVG</a></div><details><summary>All square sizes</summary><div class="links">${sizes.map(size => `<a href="${mode.id}/${type}/${type === 'full-logo' ? 'square/' : ''}oxbit-${type}-${size}x${size}.png" download>${size}px</a>`).join('')}</div></details>${type === 'full-logo' ? `<details><summary>Horizontal sizes</summary><div class="links">${[560, 1120, 2240, 4480].map(width => `<a href="${prefix}-${width}x${width * 2 / 7}.png" download>${width} × ${width * 2 / 7}</a>`).join('')}<a href="${mode.id}/${type}/square/oxbit-full-logo-square.svg" download>Square SVG</a></div></details>` : ''}`;
}
await writeFile(join(output, 'index.html'), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Oxbit — Logo variants</title><link rel="icon" href="dark/browser/favicon.svg"><link rel="stylesheet" href="preview.css"></head>
<body><header><a href="../">← Brand assets</a><a class="button" href="../oxbit-brand-kit.zip" download>Download complete kit ↗</a></header><main><p class="eyebrow">OXBIT / LOGO EXPORTS</p><h1>Every surface. Every size.</h1><p class="intro">Full logos and marks in four color modes. Outlined SVG masters, high-resolution PNGs, and browser icons, ready to use.</p><p class="note">Dark and Light describe the intended background. Transparent variants keep the same artwork colors. Square sizes run from 16px to 2048px.</p>
${modes.map(mode => `<section><div class="section-heading"><h2>${mode.label}</h2><span>${mode.transparent ? 'Transparent canvas' : mode.background.toUpperCase()}</span></div><div class="grid"><article><div class="preview ${mode.id}"><img src="${mode.id}/full-logo/oxbit-full-logo.svg" alt="Oxbit full logo — ${mode.label}" width="560" height="160"></div><div class="body"><h3>Full logo</h3><p>Horizontal · 2240 × 640 default PNG</p>${downloads(mode, 'full-logo')}</div></article><article><div class="preview mark ${mode.id}"><img src="${mode.id}/logo-mark/oxbit-logo-mark.svg" alt="Oxbit logo mark — ${mode.label}" width="64" height="64"></div><div class="body"><h3>Logo mark</h3><p>Square · 1024 × 1024 default PNG</p>${downloads(mode, 'logo-mark')}</div></article></div><div class="browser"><div><h3>Browser &amp; home screen</h3><p>Optically adjusted favicon. Opaque Apple Touch Icon.</p></div><div class="links"><a href="${mode.id}/browser/favicon.ico" download>ICO · 16 / 32 / 48</a><a href="${mode.id}/browser/favicon.svg" download>Favicon SVG</a>${[16, 32, 48].map(size => `<a href="${mode.id}/browser/favicon-${size}x${size}.png" download>${size}px PNG</a>`).join('')}<a href="${mode.id}/browser/apple-touch-icon.png" download>Apple · 180px</a>${[120, 152, 167].map(size => `<a href="${mode.id}/browser/apple-touch-icon-${size}x${size}.png" download>Apple · ${size}px</a>`).join('')}</div></div></section>`).join('\n')}
</main><footer><p>Use the mark for small icons. Square full-logo exports preserve the horizontal layout.</p><a href="README.md">Usage &amp; file guide</a> · <a href="manifest.json">Asset manifest</a></footer></body></html>\n`);
await writeFile(join(output, 'preview.css'), `:root{font-family:system-ui,sans-serif;color:#14161a;background:#f2f3ef}*{box-sizing:border-box}body{margin:0}header,main,footer{max-width:1200px;margin:auto;padding:32px}header{display:flex;justify-content:space-between;align-items:center;gap:20px}a{color:inherit;text-underline-offset:4px}a:focus-visible,summary:focus-visible{outline:3px solid #0f7b6c;outline-offset:5px}.button{background:#14161a;color:#f2f3ef;padding:14px 18px;border-radius:6px;text-decoration:none;font-size:13px}.eyebrow{font-size:11px;letter-spacing:.15em;color:#0f7b6c}h1{font-size:clamp(32px,5vw,60px);font-weight:500;letter-spacing:-.05em;margin:12px 0 20px}.intro{max-width:640px;line-height:1.6;font-size:18px}.note{max-width:720px;font-size:13px;line-height:1.7;color:#596365}section{margin-top:48px}.section-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:16px}h2{font-size:22px;font-weight:500;margin:0}.section-heading span{font-size:12px;color:#596365}.grid{display:grid;grid-template-columns:1.6fr 1fr;gap:16px}article{border:1px solid #d7dcd8;border-radius:8px;overflow:hidden;background:#fff}.preview{height:240px;display:flex;align-items:center;justify-content:center;padding:32px}.preview img{width:100%;height:auto;max-height:180px;object-fit:contain}.preview.mark img{width:144px;height:144px}.dark{background:#14161a}.light{background:#f2f3ef}.dark-transparent{background-color:#24282e;background-image:conic-gradient(#353b43 25%,transparent 0 50%,#353b43 0 75%,transparent 0);background-size:24px 24px}.light-transparent{background-color:#fff;background-image:conic-gradient(#e2e5e1 25%,transparent 0 50%,#e2e5e1 0 75%,transparent 0);background-size:24px 24px}.body{padding:24px}h3{font-size:15px;margin:0 0 8px}.body p,.browser p{font-size:12px;color:#596365;margin:0 0 18px}.links{display:flex;flex-wrap:wrap;gap:12px 18px;font-size:13px}.links a{color:#0f7b6c}details{margin-top:18px}summary{cursor:pointer;font-size:12px;margin-bottom:12px}.browser{display:flex;justify-content:space-between;align-items:center;gap:32px;padding:24px;margin-top:16px;border:1px solid #d7dcd8;border-radius:8px}.browser>div{flex:1}.browser p{margin-bottom:0}footer{font-size:12px;color:#596365;line-height:1.8;padding-bottom:48px}@media(max-width:640px){header,main,footer{padding:24px}.grid{grid-template-columns:1fr}.preview{height:200px}.browser{display:block}.browser .links{margin-top:20px}header{font-size:12px}.button{font-size:11px;padding:12px}.section-heading{align-items:start}.section-heading span{text-align:right}}\n`);

// Build outside the public tree so the archive cannot include itself.
const temporary = await mkdtemp(join(tmpdir(), 'oxbit-brand-kit-'));
try {
  const archive = join(temporary, 'oxbit-brand-kit.zip');
  execFileSync('zip', ['-q', '-r', archive, 'brand', 'favicon.svg', 'favicon.ico', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'site.webmanifest', 'fonts/oxbit-font-0.woff2', 'fonts/oxbit-font-3.woff2', 'fonts/oxbit-font-4.woff2', 'fonts/instrumentsans-OFL.txt', 'fonts/jetbrainsmono-OFL.txt', '-x', 'brand/oxbit-brand-kit.zip', '*.DS_Store'], { cwd: publicDir });
  await copyFile(archive, join(brandDir, 'oxbit-brand-kit.zip'));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
console.log(`Saved ${files.length} assets, gallery, guide, manifest, and complete brand-kit ZIP.`);
