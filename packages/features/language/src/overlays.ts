import { StateEffect, StateField, type Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet } from "@codemirror/view";
import { textOffset, textPosition } from "@oxbit/sdk";
import { showDocumentation, hideDocumentation } from "./popups.js";
export interface TokenLegend { tokenTypes: string[]; tokenModifiers: string[] }
export const semanticTypes = ["namespace", "type", "class", "enum", "interface", "struct", "typeParameter", "parameter", "variable", "property", "enumMember", "event", "function", "method", "macro", "keyword", "modifier", "comment", "string", "number", "regexp", "operator", "decorator"];
export const semanticModifiers = ["declaration", "definition", "readonly", "static", "deprecated", "abstract", "async", "modification", "documentation", "defaultLibrary"];
const colors: Record<string, string> = { namespace: "type", type: "type", class: "type", enum: "type", interface: "type", struct: "type", typeParameter: "type", parameter: "variable", variable: "variable", property: "property", enumMember: "property", event: "property", function: "function", method: "function", macro: "function", keyword: "keyword", modifier: "keyword", comment: "comment", string: "string", regexp: "string", number: "number", operator: "operator", decorator: "attr" };
export function tokenDelta(previous: number[], edits: any[]): number[] {
  if (!Array.isArray(edits)) throw new Error("Invalid semantic delta");
  const ordered = [...edits].sort((a, b) => b.start - a.start), next = [...previous]; let end = previous.length;
  for (const edit of ordered) {
    if (!Number.isInteger(edit.start) || !Number.isInteger(edit.deleteCount) || edit.start < 0 || edit.deleteCount < 0 || edit.start + edit.deleteCount > end || edit.data !== undefined && !Array.isArray(edit.data)) throw new Error("Invalid semantic delta");
    next.splice(edit.start, edit.deleteCount, ...(edit.data ?? [])); end = edit.start;
  }
  return next;
}
export function semanticRanges(text: string, data: number[], legend: TokenLegend): Range<Decoration>[] {
  if (!Array.isArray(data) || data.length % 5 || data.length > 5_000_000 || data.some(value => !Number.isInteger(value) || value < 0 || value > 0x7fffffff)) throw new Error("Invalid semantic token stream");
  const ranges: Range<Decoration>[] = []; let line = 0, column = 0, end = -1;
  for (let index = 0; index < data.length; index += 5) {
    line += data[index]; column = data[index] ? data[index + 1] : column + data[index + 1];
    const length = data[index + 2], type = legend.tokenTypes[data[index + 3]], modifiers = data[index + 4];
    const from = textOffset(text, { line, character: column }), to = textOffset(text, { line, character: column + length });
    if (!length || from < end || !type || modifiers >= 2 ** legend.tokenModifiers.length) throw new Error("Invalid semantic token range");
    end = to;
    const color = colors[type]; if (!color) continue;
    const names = legend.tokenModifiers.filter((_name, bit) => modifiers & (1 << bit));
    const style = `color:var(--tok-${color});background-color:var(--tok-${color}-background);font-weight:var(--tok-${color}-weight);font-style:var(--tok-${color}-style);text-decoration:${names.includes("deprecated") ? "line-through" : `var(--tok-${color}-decoration)`}`;
    ranges.push(Decoration.mark({ class: "lsp-semantic", attributes: { style, "data-semantic-type": type, "data-semantic-modifiers": names.join(" ") } }).range(from, to));
  }
  return ranges;
}
interface OverlayHost {
  capabilities(): Record<string, any>;
  ready(): boolean;
  uri(): string;
  request(method: string, params: any, signal?: AbortSignal): Promise<any>;
  enabled(setting: string): boolean;
  applyHints(hint: any, version: string): Promise<void>;
  open(uri: string, position: { line: number; character: number }): Promise<void>;
}
const decorations = StateEffect.define<DecorationSet>();
const field = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) { if (transaction.docChanged) value = Decoration.none; for (const effect of transaction.effects) if (effect.is(decorations)) value = effect.value; return value; },
  provide: value => EditorView.decorations.from(value),
});
class HintWidget extends WidgetType {
  private cleanups = new WeakMap<HTMLElement, () => void>();
  constructor(private hint: any, private host: OverlayHost, private text: string) { super(); }
  eq(other: HintWidget) { return this.text === other.text && JSON.stringify(this.hint) === JSON.stringify(other.hint); }
  toDOM(view: EditorView) {
    const dom = document.createElement("span"); dom.className = "lsp-inlay-hint"; dom.style.cssText = "color:var(--fg-3);background:var(--bg-raised);font-size:.85em;border-radius:3px;padding:0 3px";
    if (this.hint.paddingLeft) dom.style.marginLeft = ".3em";
    if (this.hint.paddingRight) dom.style.marginRight = ".3em";
    dom.setAttribute("aria-label", "Inlay hint"); dom.tabIndex = 0;
    let hint = this.hint, controller: AbortController | undefined;
    const render = () => {
      dom.replaceChildren();
      for (const part of typeof hint.label === "string" ? [{ value: hint.label }] : hint.label ?? []) {
        const label = document.createElement(part.location ? "button" : "span"); label.textContent = part.value;
        if (part.location) { label.setAttribute("aria-label", `Go to ${part.value}`); label.onclick = event => { event.stopPropagation(); void this.host.open(part.location.uri, part.location.range.start).catch(() => {}); }; }
        dom.append(label);
      }
    };
    const resolve = () => {
      controller?.abort(); controller = new AbortController(); const current = controller;
      const result = this.host.capabilities().inlayHintProvider?.resolveProvider ? this.host.request("inlayHint/resolve", hint, current.signal) : Promise.resolve(hint);
      void result.then(value => {
        if (current.signal.aborted || !dom.isConnected) return;
        hint = value ?? hint; render();
        const tooltip = hint.tooltip ?? (Array.isArray(hint.label) ? hint.label.find((part: any) => part.tooltip)?.tooltip : undefined);
        if (tooltip) showDocumentation(view, textOffset(this.text, hint.position), tooltip);
      }).catch(() => {});
    };
    const clear = () => { controller?.abort(); };
    this.cleanups.set(dom, clear);
    dom.onmouseenter = resolve; dom.onfocus = resolve; dom.onmouseleave = clear; dom.onblur = clear;
    dom.ondblclick = () => { void this.host.applyHints(hint, this.text).catch(() => {}); };
    dom.onkeydown = event => { if (event.key === "Enter" && hint.textEdits?.length) { event.preventDefault(); void this.host.applyHints(hint, this.text).catch(() => {}); } else if (event.key === "Escape") { clear(); hideDocumentation(view); view.focus(); } };
    render(); return dom;
  }
  destroy(dom: HTMLElement) { this.cleanups.get(dom)?.(); this.cleanups.delete(dom); }
  ignoreEvent() { return true; }
}
/** One request/cache owner for every split view of an attached document. */
export class LanguageOverlays {
  private views = new Set<EditorView>();
  private timer?: ReturnType<typeof setTimeout>;
  private controller?: AbortController;
  private cached?: { text: string; data: number[]; resultId?: string };
  private epoch = 0;
  private links = new Map<string, any>();
  constructor(private host: OverlayHost) {}
  extension() {
    return [field, ViewPlugin.define(view => {
      this.views.add(view); this.schedule();
      return { update: update => { if (update.docChanged || update.viewportChanged || update.selectionSet) this.schedule(); }, destroy: () => { this.views.delete(view); if (!this.views.size) this.dispose(); else this.schedule(); } };
    }), EditorView.baseTheme({ ".lsp-semantic *": { color: "inherit !important", backgroundColor: "inherit !important", fontStyle: "inherit !important", fontWeight: "inherit !important", textDecoration: "inherit !important" } }), EditorView.domEventHandlers({
      click: event => {
        const element = (event.target as HTMLElement).closest<HTMLElement>("[data-lsp-link]");
        if (!element || !(event.ctrlKey || event.metaKey)) return false;
        event.preventDefault(); void this.followLink(element.dataset.lspLink!); return true;
      },
      keydown: event => {
        const element = (event.target as HTMLElement).closest<HTMLElement>("[data-lsp-link]");
        if (event.key !== "Enter" || !element) return false;
        event.preventDefault(); void this.followLink(element.dataset.lspLink!); return true;
      },
    })];
  }
  private async followLink(id: string) {
    const entry = this.links.get(id);
    if (!entry) return;
    try {
      let link = entry.link;
      if (!link.target && this.host.capabilities().documentLinkProvider?.resolveProvider) link = await this.host.request("documentLink/resolve", link);
      if (this.links.get(id) !== entry || typeof link.target !== "string") return;
      const url = new URL(link.target);
      if (["https:", "http:", "mailto:"].includes(url.protocol)) window.open(url.href, "_blank", "noopener,noreferrer");
      else if (url.protocol === "file:") await this.host.open(url.href, { line: 0, character: 0 });
    } catch { /* Invalid or expired links never grant file access. */ }
  }
  refresh(reset = false) {
    if (reset) this.cached = undefined;
    this.epoch++; this.controller?.abort(); this.links.clear();
    for (const view of this.views) { hideDocumentation(view); view.dispatch({ effects: decorations.of(Decoration.none) }); }
    this.schedule();
  }
  private schedule() { clearTimeout(this.timer); this.controller?.abort(); this.timer = setTimeout(() => { void this.fetch(); }, 150); }
  private async fetch() {
    const view = this.views.values().next().value as EditorView | undefined;
    if (!view || !this.host.ready()) return;
    const text = view.state.doc.toString(), epoch = this.epoch, controller = new AbortController(); this.controller = controller;
    const caps = this.host.capabilities(), large = new TextEncoder().encode(text).byteLength > 1024 * 1024 && !this.host.enabled("editor.largeFileIntelligence");
    const textDocument = { uri: this.host.uri() }, ranges: Range<Decoration>[] = [];
    const viewport = { from: Math.min(...[...this.views].map(view => view.viewport.from)), to: Math.max(...[...this.views].map(view => view.viewport.to)) };
    const range = { start: textPosition(text, viewport.from), end: textPosition(text, viewport.to) };
    try {
      if (caps.semanticTokensProvider && this.host.enabled("editor.semanticHighlighting")) {
        const provider = caps.semanticTokensProvider;
        let response: any, data: number[] | undefined;
        if (provider.full && !large) {
          if (this.cached?.text === text) data = this.cached.data;
          else if (provider.full.delta && this.cached?.resultId) {
            try {
              response = await this.host.request("textDocument/semanticTokens/full/delta", { textDocument, previousResultId: this.cached.resultId }, controller.signal);
              data = response?.data ?? tokenDelta(this.cached.data, response?.edits); semanticRanges(text, data!, provider.legend);
            } catch (error) { if (controller.signal.aborted) throw error; data = undefined; }
          }
          if (!data) { response = await this.host.request("textDocument/semanticTokens/full", { textDocument }, controller.signal); data = response?.data ?? []; }
          ranges.push(...semanticRanges(text, data!, provider.legend));
          this.cached = { text, data: data!, resultId: response?.resultId ?? (this.cached?.text === text ? this.cached.resultId : undefined) };
        } else if (provider.range) {
          response = await this.host.request("textDocument/semanticTokens/range", { textDocument, range }, controller.signal);
          ranges.push(...semanticRanges(text, response?.data ?? [], provider.legend));
        }
      }
      if (caps.documentHighlightProvider) {
        const highlights = await this.host.request("textDocument/documentHighlight", { textDocument, position: textPosition(text, view.state.selection.main.head) }, controller.signal).catch(() => []);
        for (const highlight of highlights ?? []) { try { const from = textOffset(text, highlight.range.start), to = textOffset(text, highlight.range.end); if (to > from) ranges.push(Decoration.mark({ attributes: { style: "background-color:var(--occ)" }, class: "lsp-document-highlight" }).range(from, to)); } catch { /* Ignore invalid ranges. */ } }
      }
      if (caps.documentLinkProvider && !large) {
        const links = await this.host.request("textDocument/documentLink", { textDocument }, controller.signal).catch(() => []);
        if (!controller.signal.aborted) this.links.clear();
        for (const link of links ?? []) { try {
          const from = textOffset(text, link.range.start), to = textOffset(text, link.range.end), id = `${epoch}:${from}:${to}`;
          if (to <= from) continue;
          this.links.set(id, { link });
          ranges.push(Decoration.mark({ class: "lsp-document-link", attributes: { "data-lsp-link": id, title: link.tooltip ?? "Control/Command-click to follow link", role: "link", tabindex: "0", style: "text-decoration:underline;text-decoration-color:var(--tok-link)" } }).range(from, to));
        } catch { /* Ignore invalid ranges. */ } }
      }
      if (caps.inlayHintProvider && !large && (this.host.enabled("editor.inlayHints.types") || this.host.enabled("editor.inlayHints.parameters"))) {
        const hints = await this.host.request("textDocument/inlayHint", { textDocument, range }, controller.signal).catch(error => { if (controller.signal.aborted) throw error; return []; });
        for (const hint of hints ?? []) {
          if (hint.kind === 1 && !this.host.enabled("editor.inlayHints.types") || hint.kind === 2 && !this.host.enabled("editor.inlayHints.parameters")) continue;
          try { const at = textOffset(text, hint.position); if (at < viewport.from || at > viewport.to) continue; ranges.push(Decoration.widget({ widget: new HintWidget(hint, this.host, text), side: 1 }).range(at)); } catch { /* Ignore malformed hints. */ }
        }
      }
      if (controller.signal.aborted || epoch !== this.epoch) return;
      const value = Decoration.set(ranges, true);
      for (const target of this.views) if (target.state.doc.toString() === text) target.dispatch({ effects: decorations.of(value) });
    } catch { /* Syntax remains usable when background intelligence fails. */ }
  }
  dispose() { clearTimeout(this.timer); this.controller?.abort(); this.cached = undefined; this.links.clear(); this.epoch++; }
}
