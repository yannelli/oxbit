# Settings UI

Created: 2026-10-10. Last updated: 2026-10-10.

This guide describes the Settings screen in `packages/features/settings` and the parts of Zed's Settings Editor it follows. For settings files, precedence, and the schema, see [JSON settings](settings.md).

## Sources

- Zed blog, "Settings UI" (2025-12-12): https://zed.dev/blog/settings-ui
- Zed `settings_ui.rs`: https://raw.githubusercontent.com/zed-industries/zed/main/crates/settings_ui/src/settings_ui.rs
- Zed `page_data.rs`: https://raw.githubusercontent.com/zed-industries/zed/main/crates/settings_ui/src/page_data.rs

## Zed findings

- A sidebar lists pages (General, Appearance, Keymap, Editor, Languages & Tools, and others). Controls sit on the right. Each page groups items under section headers, and the active page lists its sections as child nav entries.
- A row has a title and a small muted description on the left, at most about two thirds of the width, and the control on the right.
- A Reset to Default button appears only when the current file sets the value and it differs from the default.
- The JSON path sits behind a copy button that appears on hover.
- Booleans are switches, enums are dropdowns, and numbers get a number field.
- Per-language settings live on sub-pages reached by a row with a Configure button.
- Arrays and objects the UI cannot edit get an Edit in settings.json button.
- One search box filters every page and groups the results.
- User and Project files are separate tabs.

## How Oxbit maps them

### Pages and sections

`layout.ts` derives pages from `Setting.category`. The text before ` · ` is the page and the rest is the section, so `Editor · Typography` lands in the Typography section of the Editor page. A setting without a category goes to the Extensions page. Pages follow this order: Appearance, Editor, Formatting, Files, Terminal, Source Control, Language Servers, Runtime, Desktop, Agent ACP. Other pages follow in first-seen order, and Extensions comes last. Within a page, settings without a section come first, then each section in first-seen order.

Settings opens on the first page. At 600px and wider, the sidebar (`nav` labelled "Setting categories") lists the pages, the active page's sections as indented buttons that scroll to the section heading, and a Keyboard Shortcuts button at the bottom.

A non-empty search or the Modified filter shows matches from every page, grouped under page and section headings. Search matches the translated title, the id, the translated description, and the page and section names.

### Rows

`rows.tsx` renders every row as `.setting-row.setting-field` with `data-setting-id`. The title and description sit on the left and the control on the right. String lists, JSON textareas, and the theme pickers use the `stacked` variant, with the control below the text. Booleans are `<input type="checkbox" role="switch">`.

The Reset button renders only when the current scope or language override sets the value (`scopedSetting(...).modified`). A Copy setting ID button writes the id to the clipboard. It shows on hover or focus with a fine pointer and is hidden with a coarse pointer, where search and Edit as JSON still expose ids.

The Theme Packs and Git Accounts action rows use the same layout with a button as the control, at the top of the Appearance and Source Control pages.

### Language Servers

Each language server is its own extension (`oxbit.language-<id>` on the runtime and on iOS), and its settings use the category `Language Servers · <name>`. With no search and no Modified filter, the Language Servers page shows one row per extension from `kernel.extensions.list()` whose configuration has such a category, so disabled servers still appear. Each row has a switch that enables or disables the extension and writes `extension-enabled` and `extension-disabled` like the Extensions page, plus a Configure button that runs `settings.open` with `{ extension }`. The per-extension page groups that extension's settings by section, and omits the page heading when all settings share one page and the section heading when there is one section.

### Chip editor

`items: "string"` arrays use a chip editor. Each item is a chip with a "Remove {item}" button. The "Add to {title}" input adds an item on Enter or with the Add button. Empty and duplicate entries are ignored, and validation errors show in the row's alert.

### Phone

Below 600px (`usePhone`, a `matchMedia("(max-width: 599px)")` hook), the content area opens on a page list with 44px rows. Choosing a page shows it with a back button labelled "All settings". A search or the Modified filter replaces the list with grouped results. The search box stays in the header on every view. Switches, enum selects, and number inputs (the `compact` variant) sit on the title line, right-aligned, with the description below at full width; the select is at most 45% of the viewport width. Text inputs, string lists, JSON textareas, and the theme pickers stack below the text.

### Edit as JSON

Oxbit has no single settings.json editor tab for each scope and language layer, so the Edit as JSON dialog edits the layer shown in the header: user or workspace, or that scope's language layer when a language override is selected. Apply parses the JSON, calls `configuration.set` for changed keys and `configuration.reset` for removed keys, and leaves unchanged keys alone. If any call throws, `configuration.import` restores the snapshot taken before Apply and the dialog shows the error. Object settings keep their inline textarea.

## Tests

- `packages/features/settings/src/layout.test.ts` and `json-layer.test.ts`
- `tests/browser/settings-pages.spec.ts` (chromium): pages and sections, search grouping, Edit as JSON apply and rollback, Language Servers rows and the chip editor
- `tests/browser/mobile.spec.ts` (webkit-phone): page list, drill-down and back, phone Configure page
- `tests/browser/settings-header.spec.ts`: header control heights and the keyboard view
