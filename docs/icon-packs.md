# Icon packs

Use **Preferences: Import Icon Pack…** or **Extensions → Icon Packs → Manage Icon Packs**. Review the publisher, version, license, theme list, sample icons and compatibility warnings, then install. Installation does not change your selections. File/folder icons and application controls have independent selectors in Settings and the command palette.

Oxbit ships **ClassicOS 98 Icons** (`oxbit.classicos98`) and **Rainbow Pride Icons** (`oxbit.rainbow-icons`), installed on first launch. They behave like imported packs in Extensions → Icon Packs. Uninstalling either is remembered for the origin, across projects and launches, until its bundled revision changes.

**Rainbow Pride** includes bold rainbow flag stripes and Progress Pride chevrons, with readable file-type badges, covering 225 file extensions, 142 filenames, 41 folder names, and all 63 themeable application controls. File and folder artwork follows the color theme's light/dark mode. Choose it independently in the File Icon Theme and Product Icon Theme settings, or run **Use Rainbow Dark Theme and Icons** / **Use Rainbow Light Theme and Icons** to apply the matching palette and both icon selections together. Oxbit branding and explicitly preserved application glyphs retain their appearance.

A ready-made pack is in the repository at `examples/icon-packs/jetbrains-icons.zip` (`oxbit.jetbrains-icons`): IntelliJ-style file icons for 150 extensions, 87 file names and 14 folder names. Import it like any other archive. It is not installed on first launch and adds nothing to the application bundle. **JetBrains 2023+** follows the editor's light or dark mode; **JetBrains 2023+ Dark** and **JetBrains 2023+ Light** pin one variant. `tsx scripts/build-jetbrains-icon-pack.ts` rebuilds it from a pinned upstream commit, validating every SVG before writing; the source URLs and SHA-256 hashes land in `examples/icon-packs/upstream.json`.

`workbench.iconTheme` and `workbench.productIconTheme` default to `oxbit.default`. Installed IDs are `publisher.package/themeId`; existing user/workspace configuration precedence applies. Disabled, missing, corrupt and removed packs fall back to Oxbit defaults while retaining the selected ID. Re-enable or reinstall the pack to restore it. Replacing a pack with an invalid archive or failing storage write preserves the prior installation.

## Authoring

Oxbit reads the existing [VS Code file icon format](https://code.visualstudio.com/api/extension-guides/file-icon-theme) and [product icon format](https://code.visualstudio.com/api/extension-guides/product-icon-theme). A ZIP has `package.json` at its root; a VSIX has `extension/package.json`. Include theme files, referenced images/fonts and their license and attribution files. Multiple themes of either type can share a package.

Example `package.json`:

```json
{
  "publisher": "example",
  "name": "icons",
  "version": "1.0.0",
  "displayName": "Example Icons",
  "license": "MIT",
  "contributes": {
    "iconThemes": [{ "id": "files", "label": "Example Files", "path": "themes/files.json" }],
    "productIconThemes": [{ "id": "controls", "label": "Example Controls", "path": "themes/controls.json" }]
  }
}
```

Example `themes/files.json` (images live in `images/`):

```json
{
  "iconDefinitions": {
    "file": { "iconPath": "../images/file.svg" },
    "folder": { "iconPath": "../images/folder.svg" },
    "open": { "iconPath": "../images/folder-open.svg" },
    "typescript": { "iconPath": "../images/typescript.svg" }
  },
  "file": "file",
  "folder": "folder",
  "folderExpanded": "open",
  "fileExtensions": { "ts": "typescript", "d.ts": "typescript" },
  "fileNames": { "src/config.ts": "typescript" },
  "languageIds": { "typescript": "typescript" },
  "light": { "file": "file" },
  "highContrast": { "file": "file" }
}
```

Example `themes/controls.json` (supply a licensed font containing the chosen glyph, or point `iconPath` at an image):

```json
{
  "fonts": [{ "id": "controls", "src": [{ "path": "../fonts/controls.woff", "format": "woff" }] }],
  "iconDefinitions": { "search": { "fontCharacter": "\\e001", "fontId": "controls" } }
}
```

Both kinds support SVG/PNG images and WOFF, WOFF2, TTF and OTF glyphs. A font glyph takes the control's current color; an image is drawn as authored and is not recolored. Filename matches precede extensions, longest compound extensions precede shorter ones, then language IDs and generic defaults. Parent-qualified associations take precedence within their kind. Matching is case insensitive. Folder names, root folders, expanded folders, light and high-contrast association overrides are supported. High contrast uses explicit color-theme metadata. Explorer arrows disappear only where different usable open/closed folder resources exist.

Draft 2020-12 schemas are checked in under `packages/icon-themes/src/schemas/` and served at `/schemas/icon-manifest.v1.schema.json`, `/schemas/icon-file.v1.schema.json`, and `/schemas/icon-product.v1.schema.json`. Validators are generated with Ajv standalone compilation, bundled without runtime code generation, and work offline. JSONC comments and trailing commas are accepted.

```sh
bun run icons:schemas
bun run icons:validate path/to/icons.zip path/to/icons.vsix
bun run test:icons:browser
# After bun run desktop:prepare on a supported desktop host:
bun run test:icons:desktop
```

The CLI checks archive structure, schemas, references and assets and decodes referenced font outlines with fontkit. The application additionally uses its native image/font decoders before installation. Pinned, licensed image and product-font examples are in `tests/fixtures/icon-packs/`; the manifests, exact upstream revisions, URLs and SHA-256 hashes are recorded in `upstream.json`. `node scripts/fetch-icon-fixtures.mjs` reproduces these declarative subsets without building or executing upstream code.

## Compatibility and storage

No extension scripts, activation code or entrypoints execute during import or rendering. Unsupported contributions and theme features appear in the preview. Configuration-dependent generation, executable extensions, online catalog browsing, automatic updates, language-contributed default image icons, animated SVG, embedded SVG stylesheets and external assets are not supported. Unknown top-level theme fields are ignored with warnings; unsupported fields inside definitions are rejected by the supported-format schemas. Native application icons and Oxbit branding retain their appearance.

Archives are bounded to 50 MiB compressed, 200 MiB actual decompressed data, 20,000 entries, 10 MiB per resource and 5 MiB per JSON file. These limits also bound ignored entry output. Cancellation stops decompression and prevents installation. Encrypted entries, symlinks/special files, duplicate normalized paths, absolute paths, escaping references, external URLs, active SVG and invalid image/font data are rejected. PNG dimensions are bounded and SVGs render as isolated images, never injected markup. FontFace objects use validated bytes and unique session-scoped family names. Replacements and teardown dispose fonts and object URLs.

Browser storage uses the dedicated `oxbit-icon-packs-v1` IndexedDB database, shared across workspaces. Revision and index writes form one atomic transaction. Desktop storage uses `icon-packs-v1/` in the application data directory, separate from project recovery data: it persists immutable revisions before atomically switching the index under the application storage lock. Successful mutations notify other windows; superseded and abandoned revisions are collected on successful mutations. Storage failures preserve the previous index. Importing a replacement preserves an existing pack's enabled/disabled state.
