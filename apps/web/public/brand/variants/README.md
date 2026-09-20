# Oxbit logo exports

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

Square PNG sizes: 16 × 16, 24 × 24, 32 × 32, 48 × 48, 64 × 64, 96 × 96, 128 × 128, 144 × 144, 152 × 152, 180 × 180, 192 × 192, 256 × 256, 384 × 384, 512 × 512, 1024 × 1024, 2048 × 2048.

Use the logo mark for small application icons; the full logo is supplied in square form for completeness but its wordmark is not legible at favicon sizes. Favicons retain the existing optically adjusted small-size geometry. All other exports preserve the original logo geometry and clear space. Opaque backgrounds fill the canvas without pre-rounded corners.

Apple Touch Icons intentionally have an opaque matching background in every mode, including the transparent folders. Use the regular logo-mark PNGs when actual transparency is needed. Platform launch icons use the mark, whose square layout is appropriate for these surfaces.

Open index.html for previews and individual downloads. The parent oxbit-brand-kit.zip includes this complete collection plus the original assets. manifest.json lists every rendered asset, including PNG dimensions and transparency.

## Regenerate

From the repository root, run `node scripts/render-brand-assets.mjs`. Requires the existing @playwright/test dependency, its Chromium browser (`bunx playwright install chromium`), and the system zip command. PNG dimensions and alpha coverage are checked during rendering. The script also rebuilds the full brand-kit ZIP.
