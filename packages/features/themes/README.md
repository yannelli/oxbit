# JSON theme packs

See [authoring and importing packs](../../../docs/themes/README.md), [token reference](../../../docs/themes/tokens.md), and [surface inventory](../../../docs/theme-coverage.md).

# Oxbit Themes

## VS Code packs

Two independently enabled built-in extensions provide the VS Code palettes:

| Pack | Variants |
| --- | --- |
| **VS Code Themes** | VS Code Light Modern, VS Code Dark Modern, VS Code Light+, VS Code Dark+, VS Code 2026 Light, VS Code 2026 Dark |
| **VS Code High Contrast Themes** | VS Code High Contrast Dark, VS Code High Contrast Light |

Choose them in **Settings → Color Theme**, or search **Use VS Code** in the command palette. The light/dark toggle pairs Modern with Modern, Plus with Plus, 2026 with 2026, and High Contrast with High Contrast. Manage each pack separately in Extensions.

These are adaptations of [Microsoft's default themes](https://github.com/microsoft/vscode/tree/5a67e0f1cc6b5db6bb8eea3c8c31e1019d8954d1/extensions/theme-defaults/themes), pinned to commit `5a67e0f1cc6b5db6bb8eea3c8c31e1019d8954d1`. `src/packs/oxbit.vscode.json` and `src/packs/oxbit.vscode-hc.json` contains the complete Oxbit palettes. Run `node scripts/import-vscode-themes.mjs` from the repository root to regenerate them. The importer resolves JSONC includes through Modern → Plus → Visual Studio and maps representative TextMate scopes to Oxbit's smaller syntax palette. Missing UI colors use the corresponding VS Code color-registry defaults or explicit fallback colors.

Oxbit provides independent semantic roles for controls, links, and selected rows; these adaptations initially inherit their corresponding palette colors. Classic list selections and High Contrast editor selections use tinted fills to preserve text colors; High Contrast uses the upstream contrast border as its shared accent. Borders and focus indicators use the VS Code High Contrast defaults. These packs adapt colors to Oxbit's layout and CodeMirror renderer; they do not import VS Code's full TextMate/semantic highlighting engine. Source colors are preserved where mapped, including upstream muted text colors; the standard pack does not promise a uniform contrast ratio for every token.

Microsoft's [MIT license](LICENSE.vscode.txt) applies to the derived palettes.

## Binx

The **Binx** pack includes three dark themes:

- **Binx**: near-black surfaces, crisp white accents, subtle gray borders, and selective color in syntax, focus, and status indicators.
- **Binx Moon**: softer charcoal surfaces with silver-lavender accents and muted syntax colors.
- **Binx Midnight**: Nord-inspired blue-gray surfaces with frost, sage, sand, and lilac accents.

Choose a variant in **Settings → Color Theme**, or search for **Use Binx** in the command palette. All three palettes live in `src/packs/oxbit.binx.json`. The light/dark toggle switches from these dark-only variants to Paper; toggling back uses Graphite.

## ClassicOS 98

**ClassicOS 98** is a Windows 98/2000 era desktop treatment: a colour theme pack, a matching icon pack, and scoped chrome CSS.

| Theme | Mode | Scheme |
| --- | --- | --- |
| **ClassicOS 98** | light | Grey 3D face, navy selection, black window text |
| **ClassicOS 2000** | light | The same face with the Windows 2000 title blue and softer dark edge |
| **ClassicOS 98 Eggplant** | dark | Plum chrome with an olive selection bar |
| **ClassicOS 98 High Contrast Black** | dark, high contrast | Black chrome, white text, system yellow accent |

Choose a variant in **Settings → Color Theme**, search **Use ClassicOS** in the command palette, or run **Use ClassicOS 98 Theme and Icons** to set the colour theme, file icons and control icons together. The light/dark toggle pairs ClassicOS 98 with Eggplant. Palettes live in `src/packs/oxbit.classicos98.json`; the terminal uses the 16-colour VGA text palette, UI text falls back through Tahoma and MS Sans Serif, and code falls back through Fixedsys and Lucida Console.

`src/classicos98/` builds the icon pack: 16x16 pixel art in the VGA palette, written as one character per pixel and rendered to SVG rects at module load. It ships a file icon theme (documents, manila folders, drives, and colour-coded language chips) and two product icon themes covering every control id in `packages/ui/src/product-icons.ts`: **ClassicOS 98** for the light schemes and **ClassicOS 98 Dark**, whose neutral ramp is inverted so black-outlined art reads on the Eggplant and High Contrast faces. **Use ClassicOS 98 Theme and Icons** picks the pair that matches the current light/dark mode. `packages/app-workbench` installs it into the icon pack store on first launch, so **Extensions → Icon Packs** can enable, replace, or uninstall it like any imported pack; uninstalling it is remembered for the origin until the bundled revision changes.

The 3D bevels are in `packages/ui/src/classicos98.css`, scoped to `[data-theme-pack="oxbit.classicos98"]` and applied only through inset box shadows, so no rule there changes layout. Its edge colours are declared in `tokens.css` and invert for the dark variants.

This is an original palette and icon set in the visual style of late-1990s desktop systems. It includes no Microsoft assets, fonts, or artwork.

## Load Bearing

Load Bearing is an original theme family inspired by [Claude](https://claude.com/): warm paper, quiet ink, terracotta accents, and restrained sage, ochre, blue, and plum syntax colors.

Choose **Load Bearing (light)** or **Load Bearing (dark)** in **Settings → Color Theme**, or search for **Use Load Bearing** in the command palette. The existing light/dark toggle stays within the selected family. Installing this update leaves the current theme selection unchanged.

Both variants are bundled in `@oxbit/feature-themes` and use the existing theme contribution API. `src/load-bearing.ts` contains the complete workbench and editor palettes, including selections, search matches, diagnostics, and Git states. Oxbit logos and existing UI/code fonts remain intact.

This package does not modify the Tauri app, native window chrome, or terminal emulator renderer. The terminal currently supplies its own colors outside the workbench theme contribution API.
