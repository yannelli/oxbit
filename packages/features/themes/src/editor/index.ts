import type { Extension, Kernel } from "@oxbit/sdk";
import type { ThemePackStore } from "@oxbit/themes";
import { translate as tr } from "@oxbit/ui";
import type { WorkbenchController } from "@oxbit/workbench";
import { ThemeEditor, type EditorStart } from "./view.js";

export const THEME_EDITOR_FEATURE_ID = "oxbit.theme-editor";
export const THEME_EDITOR_COMMANDS = {
  new: "theme.editor.new",
  /** Opens the selected theme, or `{ packId, themeId }` when given. */
  edit: "theme.editor.edit",
} as const;

export function createThemeEditorFeature({
  kernel,
  workbench,
}: {
  kernel: Kernel;
  workbench?: WorkbenchController;
}): Extension {
  let request = 0;
  const open = (start: EditorStart) => {
    const store = kernel.services.optional<{ store: ThemePackStore }>("themePacks")?.store;
    if (!workbench) return;
    if (!store) return workbench.notify(tr("The Theme Editor needs the Oxbit Themes extension. Enable it in Extensions."), "warning");
    workbench.openView("theme-editor", tr("Theme Editor"), ThemeEditor, { kernel, workbench, store, start, request: ++request });
  };
  return {
    manifest: {
      manifestVersion: 1,
      id: THEME_EDITOR_FEATURE_ID,
      name: "Theme Editor",
      description:
        "Create and edit color themes: every workbench, editor and terminal color, syntax styles, typography and shadows, with a live preview, contrast checks, light/dark pairs and JSON editing. Themes are saved as theme packs.",
      version: "1.0.0",
      sdk: "^1.0.0",
      enabledByDefault: false,
      environments: ["browser", "embedded"],
      activation: ["*"],
      capabilities: [],
      contributions: [],
    },
    activate(ctx) {
      ctx.own(ctx.commands.register({ id: THEME_EDITOR_COMMANDS.new, title: "New Color Theme", category: "Preferences", run: () => open("new") }));
      ctx.own(
        ctx.commands.register({
          id: THEME_EDITOR_COMMANDS.edit,
          title: "Edit Color Theme",
          category: "Preferences",
          run: (args?: unknown) => {
            const target = args as { packId?: unknown; themeId?: unknown } | undefined;
            open(typeof target?.packId === "string" && typeof target.themeId === "string" ? { packId: target.packId, themeId: target.themeId } : "current");
          },
        }),
      );
    },
  };
}
