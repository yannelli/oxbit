import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import type { FeatureOptions } from "@oxbit/sdk";

export function logLocations(text: string) {
  return [...text.matchAll(/(?:^|[\s("'])([\w.@-]+(?:\/[\w.@+-]+)+):([1-9]\d*)(?::([1-9]\d*))?/g)].flatMap(match => {
    const path = match[1].replace(/^\.\//, "");
    if (path.split("/").includes("..") || path.startsWith("/") || Number(match[2]) > 2 ** 31 || Number(match[3] ?? 1) > 2 ** 31) return [];
    const from = match.index + match[0].indexOf(match[1]);
    return [{ from, to: match.index + match[0].length, path, line: Number(match[2]), col: Number(match[3] ?? 1) }];
  });
}
export function logLinkExtensions(o: FeatureOptions) {
  return [ViewPlugin.fromClass(class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = this.build(view); }
    update(update: ViewUpdate) { if (update.docChanged || update.viewportChanged) this.decorations = this.build(update.view); }
    build(view: EditorView) {
      return Decoration.set(view.visibleRanges.flatMap(range => logLocations(view.state.sliceDoc(range.from, range.to)).map(link => Decoration.mark({
        class: "lsp-log-link", attributes: { "data-log-path": link.path, "data-log-line": String(link.line), "data-log-col": String(link.col), title: `Open ${link.path}:${link.line}`, role: "link", tabindex: "0" },
      }).range(range.from + link.from, range.from + link.to))), true);
    }
  }, { decorations: plugin => plugin.decorations }), EditorView.domEventHandlers({
    click(event) { return open(event); },
    keydown(event) { return event.key === "Enter" ? open(event) : false; },
  }), EditorView.baseTheme({ ".lsp-log-link": { color: "var(--tok-link)", textDecoration: "underline", cursor: "pointer" } })];
  function open(event: Event) {
    const element = (event.target as HTMLElement)?.closest<HTMLElement>("[data-log-path]");
    if (!element) return false;
    event.preventDefault();
    void Promise.resolve(o.workbench.openFile(element.dataset.logPath!, { line: Number(element.dataset.logLine), col: Number(element.dataset.logCol) })).catch(error => o.workbench.notify(String(error), "error"));
    return true;
  }
}
