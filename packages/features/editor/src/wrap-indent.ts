import { RangeSetBuilder, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import type { Kernel } from "@oxbit/sdk";
import { PHONE_QUERY } from "@oxbit/ui";

export const phoneLayout = () => typeof matchMedia === "function" && matchMedia(PHONE_QUERY).matches;

export function explicitSetting(kernel: Kernel, id: string, language?: string) {
  const data = kernel.configuration.export() as {
    user: Record<string, unknown>;
    workspace: Record<string, unknown>;
    userLanguages: Record<string, Record<string, unknown>>;
    workspaceLanguages: Record<string, Record<string, unknown>>;
  };
  return [
    data.user,
    data.workspace,
    language ? data.userLanguages[language] : undefined,
    language ? data.workspaceLanguages[language] : undefined,
  ].some((layer) => layer && Object.hasOwn(layer, id));
}

/** Phone layouts wrap by default; an explicit `editor.wordWrap` in any layer wins. */
export function effectiveWordWrap(kernel: Kernel, language: string | undefined, phone: boolean): string {
  const value = kernel.configuration.get<string>("editor.wordWrap", language) ?? "off";
  return phone && !explicitSetting(kernel, "editor.wordWrap", language) ? "on" : value;
}

/** Columns that wrapped continuation rows shift by: the line's leading whitespace plus one indent unit. */
export function hangingColumns(text: string, tabSize: number, unit: number) {
  let columns = 0;
  for (const c of text.match(/^[\t ]*/)![0]) columns += c === "\t" ? tabSize - (columns % tabSize) : 1;
  return columns + unit;
}

/** `basePadding` must match the `.cm-line` left padding so the first row keeps its position. */
export function hangingIndent(tabSize: number, unit: number, basePadding = "8px"): Extension {
  const styles = new Map<number, Decoration>();
  const decoration = (columns: number) => {
    let line = styles.get(columns);
    if (!line) {
      line = Decoration.line({ attributes: { style: `padding-left:calc(${basePadding} + ${columns}ch);text-indent:-${columns}ch` } });
      styles.set(columns, line);
    }
    return line;
  };
  const build = (view: EditorView) => {
    const builder = new RangeSetBuilder<Decoration>();
    let last = -1;
    for (const range of view.visibleRanges) {
      for (let at = range.from; at <= range.to;) {
        const line = view.state.doc.lineAt(at);
        if (line.number !== last) {
          last = line.number;
          builder.add(line.from, line.from, decoration(hangingColumns(line.text, tabSize, unit)));
        }
        at = line.to + 1;
      }
    }
    return builder.finish();
  };
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view);
      }
      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged) this.decorations = build(update.view);
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
}
