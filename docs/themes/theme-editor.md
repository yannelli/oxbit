# Theme Editor

Created: 2026-10-20. Last updated: 2026-10-20.

The Theme Editor (`oxbit.theme-editor`) is an opt-in extension. It is off on a fresh profile. Turn it on in **Extensions → Theme Editor → Enable**. It needs **Oxbit Themes** (`oxbit.themes`), which registers the `themePacks` store.

## Opening it

| Entry point | Opens |
| --- | --- |
| Command `theme.editor.new`, New Color Theme | A new pack on the built-in base of the current light/dark mode. |
| Command `theme.editor.edit`, Edit Color Theme | The selected theme. With `{ packId, themeId }` as arguments, that theme. |
| Settings → Appearance → Theme Editor | New Color Theme. The row shows only while the extension is on. |
| Manage Theme Packs | New Color Theme, and Edit {pack} on each installed pack. |

Installed packs open in place, and **Save** updates the pack with the same ID. Bundled themes open as a copy in a new `custom.*` pack, because the store rejects bundled pack IDs. A copy keeps only the values that differ from the built-in base. Colors that follow another token, such as `editor.gutter.background` following `editor.background`, stay out of the copy unless the source theme set them.

## Editing

| Tab | Controls |
| --- | --- |
| General | Pack name, pack ID (new packs only), version, attribution and license, theme name, light/dark mode, base theme in the pack, light/dark pair, high contrast flag. |
| Colors | Every token in `packages/themes/src/catalog.json`, grouped by prefix, with a filter. A follow hint names the source token of derived colors. |
| Syntax | Foreground, background, weight, italic and underline for each parser role. |
| Typography | Family stack, size, weight, style, line height, letter spacing and ligatures for each role. |
| Effects | The popover shadow layers (up to 8). |
| JSON | The whole pack. Apply JSON runs the schema and reference checks before it replaces the draft. |

A color field accepts `#RGB`, `#RGBA`, `#RRGGBB`, `#RRGGBBAA` or `transparent`. The swatch opens the system picker. The picker sets only the RGB part and keeps the existing alpha. Invalid text stays in the field, marked invalid, and does not change the draft. Reset removes an override so the value comes from the base again.

The preview on the right sets every color, syntax style, font role and shadow from the draft: tabs, explorer rows with Git and file badges, code with selection, search, occurrence, cursor and an error underline, a completion popover, buttons and inputs, diagnostics and diff backgrounds, a terminal with all 16 ANSI colors, and Markdown preview text. Below 900 px wide the preview moves above the controls.

Errors from `validatePack` disable Save, Apply and Export. Contrast warnings (text, primary button and Markdown preview below 4.5:1) show under the toolbar and do not block saving. The history keeps up to 200 edits for Undo and Redo, including Start from and Add Light/Dark Variant.

## Saving and applying

| Action | Result |
| --- | --- |
| Save | `store.install(pack, assets)`. A new pack whose ID already exists is refused. |
| Save as New Pack | Installs a copy under a new `custom.*` ID. |
| Save and Apply | Saves if needed, then sets `workbench.colorTheme` to `pack.id/theme.id`. Restore Previous Theme sets back the theme that was selected when the editor opened. |
| Export | Downloads JSON, or a ZIP when the pack has font files. |
| Add Light/Dark Variant | Adds a theme of the other mode to the pack and pairs the two for Toggle Light/Dark Theme. |

Saved themes are ordinary theme packs in the `oxbit-theme-packs` IndexedDB store. They stay installed and selectable when the Theme Editor is turned off. Packs with local fonts keep their font files when edited or copied. The editor does not add or remove font files; import a ZIP for that (see [theme packs](README.md#local-font-assets)).

## Code

| File | Role |
| --- | --- |
| `packages/features/themes/src/editor/index.ts` | Extension manifest (`enabledByDefault: false`) and commands. |
| `packages/features/themes/src/editor/draft.ts` | Pure draft model: new, copy, edit in place, overrides, variants, validation. |
| `packages/features/themes/src/editor/view.tsx` | Editor screen, history, save and apply. |
| `packages/features/themes/src/editor/panels.tsx`, `fields.tsx` | Tab panels and form controls. |
| `packages/features/themes/src/editor/preview.tsx` | Scoped preview. |

Checks: `bunx vitest run packages/features/themes` and `bun run test:themes:browser -- -g "Theme Editor"`.
