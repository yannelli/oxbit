# Oxbit — extension surfaces

Named contribution locations for plugins, with placement rules, sizing constraints, context availability and appearance requirements. The sample extension **Bundle Inspector** (`orbitlabs.bundle-inspector`) exercises `panel`, `command`, `statusItem`, `outputChannel` and `documentView`; disabling it removes every contribution atomically.

## Contribution points

| Point | Location | Placement rule | Size | Available when | Appearance |
|---|---|---|---|---|---|
| `activityView` | Activity bar + sidebar | After built-in views, in manifest order; max 3 plugin views before overflow into `⋯` | icon 18 px in a 36×36 hit target; sidebar width follows the shell (180–520 px, 320 tablet, full phone) | workspace open | 16-grid stroke icon (1.5 px, round caps), title uppercase 11 px, section headers reuse explorer header style |
| `panel` | Bottom panel tab strip | Appended after Tasks; badge optional (count or dot) | height follows panel (100–600 px); content scrolls | workspace open, extension enabled | uppercase tab label, content on `bg.surface`, 12 px UI text, mono for data |
| `command` | Command palette, menus, keybindings | Title prefixed with contribution category (`Bundle Inspector: Analyze`); disabled with reason via `when` clause | — | `when` context (`bundleExt`) | same row template as built-ins: category muted, fuzzy highlight, shortcut right-aligned |
| `statusItem` | Status bar, right group, before participants | Priority order; icon + ≤ 14 characters; colour only for warning/error states (never decorative) | 22 px tall, padding 0 8 px; phone: hidden unless `priority: high` | extension enabled | text + optional 13 px icon; tooltip mandatory; click opens the plugin's panel or command |
| `outputChannel` | Output panel channel picker | Sorted after built-ins | — | extension enabled | plain mono lines; extension owns colouring by keyword (error/warn) |
| `documentView` | Editor group tab | Opens as a normal tab (`kind: bundle`); participates in split/drag/pin/preview; closed automatically when the extension is disabled (toast) | full editor body; content max-width 880 px centred; 20 px padding | extension enabled | inherits tab template with a 14 px stroke icon; content uses card/table primitives from the workbench (border `subtle`, radius 6) |
| `editorDecoration` (Blame Lens) | Editor line end / gutter | Right-aligned after code, muted 11 px; gutter marks 3 px wide left bar or 6 px dot | must not change line height (20 px) | LSP-independent | `fg.muted`, no background on inactive lines |
| `formatter` | `editor.format`, format-on-save | Registered per language; `editor.defaultFormatter` setting picks when several | — | file language matches | success toast "Formatted with … · N ms" |
| `theme` | Settings › Color Theme | Listed in the enum | — | always | must define every token in `design/tokens.json › color.*` |
| `setting` | Settings tab under the extension's category | Grouped as `Extensions › <name>`; supports boolean/enum/number/string with validation | — | extension installed | same row template incl. modified indicator and reset |
| `contextMenuItem` | Explorer / tab / editor / terminal menus | Appended in a plugin group after a separator; ≤ 3 items per menu per extension | — | `when` clause | title case, optional shortcut |
| `notification` | Toast + centre | Extension name as source in body; ≤ 3 actions | 360 px toast | always | info/warning/error only |
| `quickPick` | Dialog list (pick) | Reuses `dialog.type = pick` | 440 px | always | — |

## Sizing and density

Contributions inherit density tokens (`--row`, `--tab`, `--ctl`, `--ui`) so they resize with compact/comfortable, tablet (32 px rows) and phone (44 px targets). Fixed pixel heights inside contributed views are discouraged; use `var(--row)` and `var(--ctl)`.

## Context availability

Each contribution declares `when` using the shell context keys (`editor`, `lsp`, `gitRepo`, `terminal`, `workspace`, custom `ext:<id>`). Unavailable contributions remain visible but disabled with a reason in menus and the palette; panels/status items are removed rather than disabled when the extension itself is disabled.

## Appearance requirements

- Icons: 16-unit grid, 1.5 px stroke, round caps/joins, `currentColor`.
- Colour: use semantic tokens only; status colours reserved for status.
- Text: sentence case in menus/toasts, uppercase tracked labels for tab strips and section headers, mono only for identifiers, paths, versions and data.
- Motion: entrance `zin` 140 ms; respect reduced motion.
- Accessibility: every control needs an accessible name; tabs/menus/lists use the roles already used by built-in surfaces (`tablist`/`tab`, `menu`/`menuitem`, `listbox`/`option`, `tree`/`treeitem`).
- Localization: all labels come from a strings table; layouts must survive the long-label pseudo-locale (Tweaks › Long labels) without clipping.

## Lifecycle contract

`install → enable → (contributions mount) → disable → (contributions unmount, open document views close with a toast, panel switches to Terminal if the plugin tab was active, output channel removed, status item removed, commands hidden from palette/menus) → uninstall`. Failures at any step surface inline in the extension details view with Retry; the previous state is kept.
