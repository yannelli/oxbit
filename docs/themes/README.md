# Authoring Oxbit theme packs

Use **Settings → Appearance → Manage Theme Packs**, or the **Import Theme Pack…** command. Choose a JSON file or ZIP, review any messages, then select **Apply**. Imports never change selection. Importing the same pack ID updates it atomically. Export includes local fonts and notices. Packs are stored in the browser/desktop webview profile's `oxbit-theme-packs` IndexedDB database, outside project folders. Tabs and desktop sessions share changes; synchronization between devices is not provided.

Theme IDs have the form `pack.id/local-id`. Names are labels and may be duplicated. Explicit legacy built-in names migrate in their original settings scope. A disabled, removed or invalid pack leaves the requested ID intact and uses the last known mode's built-in fallback. Reinstalling restores it automatically.

```json
{
  "$schema": "/schemas/theme-pack.v1.schema.json",
  "schemaVersion": 1,
  "id": "example.ink",
  "name": "Ink",
  "version": "1.0.0",
  "themes": [
    {
      "id": "night",
      "name": "Ink at Night",
      "mode": "dark",
      "base": "builtin:dark",
      "colors": {
        "editor.background": "#151021",
        "button.primary.background": "#cfa7ff"
      },
      "syntax": { "keyword": { "foreground": "#cfa7ff", "weight": 700 } },
      "typography": { "editor": { "family": ["JetBrains Mono", "monospace"], "size": 15 } },
      "effects": { "shadow": [{ "x": 0, "y": 8, "blur": 28, "spread": 0, "color": "#00000066" }] }
    }
  ]
}
```

Omitted roles inherit a complete light/dark base. `base` can also name a local theme in this pack. Inheritance merges individual properties, including variable-font axes, and replaces arrays. A local `pairedTheme` identifies the opposite variant for the toggle command. Missing references, cycles, duplicate IDs and inheritance across modes are errors. `highContrast` is explicit metadata; contrast recommendations are warnings, not installation failures.

Colors accept `#RGB`, `#RGBA`, `#RRGGBB`, `#RRGGBBAA` and `transparent`. Fonts and effects use structured values. CSS functions, selectors, URLs and arbitrary CSS are rejected. The schema rejects unknown properties and unsupported versions.

Typography roles are `body`, `heading`, `label`, `small`, `mono`, `editor`, `terminal`, and `document`. Each supports family stacks, size in pixels, weight (100–900), style, line-height ratio, letter spacing in pixels, ligatures, and four-character variable-font axes. Explicit user/workspace/language settings take precedence; resetting restores theme typography. Existing editor line-height settings remain in pixels. Terminal font family falls back to effective editor family when the pack and settings do not specify one. xterm supports family, size, weight, line height, letter spacing and the ligatures addon; it does not expose italic style or variable axes.

Syntax roles expose foreground, background, weight, italic and underline. See [the surface inventory](../theme-coverage.md) for parser mappings. Markdown strong and emphasis retain their semantic styling. No TextMate grammar engine is included.

## Local font assets

A ZIP must contain root `theme-pack.json`. Declare each font with an ID and relative path:

```json
"fonts": [{ "id": "local-mono", "path": "fonts/local-mono.woff2", "weight": 400 }]
```

Then reference `"family": ["local-mono", "monospace"]`. Fonts get internal pack-scoped family names and are loaded through `FontFace`. The font's signature must match its WOFF2, WOFF, TTF or OTF extension. Include the font's license as LICENSE.txt or a similarly named notice. Remote font downloads are not supported. Browser font-decoding failures show a warning and retain fallbacks. Font faces are released after the last consuming session releases them.

Limits: 50 MB input, 100 MB expanded, 256 entries, 20 MB per font. Traversal, absolute paths, duplicate paths, symlinks, encrypted/unsupported ZIP entries and undeclared content are rejected before decompression/installation. No files are extracted into the workspace.

## Offline schema and tooling

The Draft 2020-12 schema is served at `/schemas/theme-pack.v1.schema.json`, exported by `@oxbit/themes/schema`, and checked in at `packages/themes/src/theme-pack.v1.schema.json`. Copy it alongside your pack for offline editing and use `"$schema": "./theme-pack.v1.schema.json"`.

VS Code association example:

```json
{"json.schemas":[{"fileMatch":["theme-pack.json","*.theme-pack.json"],"url":"./theme-pack.v1.schema.json"}]}
```

From this repository:

```sh
pnpm themes:validate examples/theme-packs/ink.theme-pack.json
pnpm themes:validate my-pack.zip
pnpm themes:generate
pnpm themes:coverage
```

`catalog.json` is the canonical token catalog. Generation produces the schema, TypeScript types, token unions, fallback CSS and an Ajv standalone validator. The validator uses no runtime compilation or `eval`, including under desktop CSP. Diagnostics include a filename and JSON Pointer. [Token reference](tokens.md).

## Extension APIs

`@oxbit/themes` exports `ThemePack`, `ResolvedTheme`, `ValidationResult`, `validatePack`, `parsePack`, `resolveTheme`, `builtinBase`, `cssVariables`, `terminalTheme`, `terminalSearch`, typography helpers, `readPackFile`, `exportPack` and `ThemePackStore`. A store provides `install`, `remove`, `enable`, `list`, `resolve`, `mode`, `load`, `reload`, `snapshot` and `subscribe`; its persistence adapter can provide `withLock` for multiple processes/tabs. The profile implementation uses Web Locks and BroadcastChannel.

Theme contributions should carry a validated `resolved` theme and `stableId` in `data`. The deprecated `legacyTheme` adapter accepts only catalogued color keys and safe color values. Built-in extension IDs and commands remain unchanged; their palettes now live in `packages/features/themes/src/packs/*.json`. VS Code import regeneration writes JSON and includes the upstream license.

Layout structure, brand imagery, external preview content, OS dialogs and terminal application truecolor output are outside v1.

Repository verification: `pnpm test:themes:browser` builds the web client and runs isolated browser/runtime fixtures. [Verification record and native limitations](../../evidence/themes/acceptance.md).
