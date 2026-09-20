# Panels, splits and floating windows

Oxbit can show tool panels in left, right and bottom docks at the same time. The title bar toggles each dock independently. Editor tabs keep their existing layout.

Drag a tool panel's tab to another tab strip to move or reorder it. Drop in the center of a group to add a tab, or near an edge to split above, below, left or right. Hidden docks appear as drop targets during a drag. Escape cancels the drag. Dividers resize with either the pointer or arrow keys.

Each group has a **⋯** (**Panel actions**) menu beside its tabs with the same move and split operations, including destinations in other floating windows. **Pop Out Panel** opens a real window that can be moved to another monitor. Closing that window, or choosing **Dock Back**, returns its panels to their prior docks. Moving a tool never creates a second instance of it.

Panel layouts are saved per workspace, including split proportions, selected tabs, dock sizes and floating window bounds. Desktop floats reopen automatically. Browsers may require a click on **Restore floating panels**; **Dock all panels** brings them back instead. A blocked pop-up leaves the source panel in place. **Reset Panel Layout** restores the default tool arrangement without changing editor tabs. The legacy sidebar-location setting supplies the default side for new or migrated layouts.

Floating windows belong to the originating workspace. They stay open while switching to another project in that window. Closing the workspace uses the existing save flow and closes its floats; canceling the save flow keeps them open. Commands that open files, dialogs or the command palette return focus to the main workspace.

## Implementation and extension API

`PanelLayout`, `PanelNode`, `PanelGroup`, `PanelSplit`, `PanelTarget`, and `DockSide` are exported by `@oxbit/sdk`. `WorkbenchService` exposes optional `getPanelLayout`, `movePanel`, `detachPanel` and `redockPanel` methods so extensions can feature-detect support on older hosts. Existing `openPanel` and `togglePanel` calls reveal a tool in its current location.

The workbench owns one stable React portal container per mounted contribution. Containers are adopted into the destination document, preserving component state and the original kernel, filesystem, terminal sessions and agent controller. The inert browser `panel.html` shell and native related blank document never boot a second runtime or workbench. This also supports existing contributed panels without a serialization adapter. Components that perform document-level operations should use their mounted element's `ownerDocument` and `ownerDocument.defaultView`.

The desktop host uses Tauri's related-window creation callback to retain same-origin access to the opener. Only the local panel shell is allowed to use this path. External links retain system-browser routing, and panel shells receive no independent project ownership. Save/quit voting involves workspace windows only; the workspace owns its child-window lifetime.

Native panel dragging uses pointer capture, preserving the operating system file-drop handler for opening dropped files. Docking back explicitly destroys the native child window after React adopts its contents. Reloading the owner retires old child documents before restoring saved floats.

## Verification

- `bunx vitest run packages/workbench/src/panel-layout.test.ts packages/workbench/src/controller.test.ts`
- `bunx playwright test tests/browser/panel-docking.spec.ts tests/browser/panel-design.spec.ts --reporter=list` after building the web application.
- `node scripts/desktop/test-panels.mjs` builds and snapshots a native-test executable with a separate application identifier and driver port. It uses the existing staged desktop runtime.

The browser suite covers both dock directions, nested splits, keyboard resizing, drag-and-drop, state retention, popup failure/recovery, themes, small screens, live terminals and a fixture agent connection. The native suite exercises related windows and close cancellation separately.

For the optional native mouse-gesture check, run `OXBIT_PANEL_MANUAL=1 node scripts/desktop/test-panels.mjs` and drag **Native test panel** from the bottom dock into the left dock when it appears. The check waits 60 seconds for that gesture. WDIO's pointer actions emit only `MouseEvent`; the browser suite automatically exercises the same native pointer strategy with real pointer input.

On macOS, the native-test build preserves Tauri's UI delegate around WDIO 1.4.0 and replaces its shared eval-message registration. Without this test-only compatibility hook, that driver swallows popups and crashes when a related window inherits its message handler. JavaScript `alert` interception is disabled in this harness; Oxbit's HTML dialogs are tested normally.
