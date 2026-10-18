import { Facet, Prec, StateEffect, StateField, type EditorState, type Extension, type Transaction } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap, type ViewUpdate } from "@codemirror/view";
import { PREFIX_CHARS, SUFFIX_CHARS } from "./prompt.js";

export interface Suggestion {
  from: number;
  text: string;
}
export interface GhostOptions {
  /** Whether typing requests suggestions; `requestSuggestion` works either way. */
  automatic(): boolean;
  delay(): number;
  /** Resolves to the cleaned suggestion for the cursor, or "". */
  suggest(context: { prefix: string; suffix: string }, signal: AbortSignal): Promise<string>;
  onError?(error: unknown): void;
}

export const setSuggestion = StateEffect.define<Suggestion | null>();
const options = Facet.define<GhostOptions, GhostOptions | undefined>({ combine: (values) => values[0] });

/** Keeps the rest of the suggestion when the user types its next characters at the cursor. */
function typedThrough(value: Suggestion, transaction: Transaction): Suggestion | null {
  let inserted: string | undefined, valid = true;
  transaction.changes.iterChanges((fromA, toA, _fromB, _toB, text) => {
    if (inserted !== undefined || fromA !== value.from || toA !== fromA) valid = false;
    inserted = text.toString();
  });
  if (!valid || !inserted || !value.text.startsWith(inserted) || inserted === value.text) return null;
  const from = value.from + inserted.length;
  return transaction.state.selection.main.empty && transaction.state.selection.main.head === from ? { from, text: value.text.slice(inserted.length) } : null;
}

export const suggestionField = StateField.define<Suggestion | null>({
  create: () => null,
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(setSuggestion)) return effect.value;
    if (!value) return null;
    if (transaction.docChanged) return typedThrough(value, transaction);
    const head = transaction.state.selection.main;
    return transaction.selection && (!head.empty || head.head !== value.from) ? null : value;
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value
    ? Decoration.set([Decoration.widget({ widget: new GhostWidget(value.text), side: 1 }).range(value.from)])
    : Decoration.none),
});

class GhostWidget extends WidgetType {
  constructor(readonly text: string) { super(); }
  eq(other: GhostWidget) { return other.text === this.text; }
  toDOM() {
    const dom = document.createElement("span");
    dom.className = "cm-ai-ghost";
    dom.setAttribute("aria-hidden", "true");
    dom.style.cssText = "color:var(--fg-3);opacity:.75;white-space:pre;pointer-events:none";
    dom.textContent = this.text;
    return dom;
  }
  ignoreEvent() { return true; }
}

export const currentSuggestion = (state: EditorState) => state.field(suggestionField, false) ?? null;

export function acceptSuggestion(view: EditorView) {
  const value = currentSuggestion(view.state);
  if (!value) return false;
  view.dispatch({ changes: { from: value.from, insert: value.text }, selection: { anchor: value.from + value.text.length },
    effects: setSuggestion.of(null), userEvent: "input.complete", scrollIntoView: true });
  return true;
}

/** Accepts up to the end of the next word, or the next run of punctuation or whitespace. */
export function acceptWord(view: EditorView) {
  const value = currentSuggestion(view.state);
  if (!value) return false;
  const word = /^(\s*[\p{L}\p{N}_$]+|\s*[^\p{L}\p{N}_$\s]+|\s+)/u.exec(value.text)?.[0] ?? value.text;
  const rest = value.text.slice(word.length);
  view.dispatch({ changes: { from: value.from, insert: word }, selection: { anchor: value.from + word.length },
    effects: setSuggestion.of(rest ? { from: value.from + word.length, text: rest } : null), userEvent: "input.complete" });
  return true;
}

export function dismissSuggestion(view: EditorView) {
  if (!currentSuggestion(view.state)) return false;
  view.dispatch({ effects: setSuggestion.of(null) });
  return true;
}

/** Requests a suggestion at the cursor now. */
export function requestSuggestion(view: EditorView) {
  const plugin = view.plugin(ghostPlugin);
  if (!plugin) return false;
  plugin.schedule(view, 0);
  return true;
}

const ghostPlugin = ViewPlugin.fromClass(class {
  timer: ReturnType<typeof setTimeout> | undefined;
  controller: AbortController | undefined;
  update(update: ViewUpdate) {
    if (!update.docChanged && !update.selectionSet) return;
    this.cancel();
    const typed = update.transactions.some((transaction) => transaction.isUserEvent("input.type") || transaction.isUserEvent("delete"));
    const config = update.state.facet(options);
    if (typed && config?.automatic() && !currentSuggestion(update.state)) this.schedule(update.view, config.delay());
  }
  schedule(view: EditorView, delay: number) {
    this.cancel();
    this.timer = setTimeout(() => void this.request(view), delay);
  }
  cancel() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.controller?.abort();
    this.controller = undefined;
  }
  async request(view: EditorView) {
    const config = view.state.facet(options), state = view.state, cursor = state.selection.main;
    if (!config || state.readOnly || !cursor.empty || state.selection.ranges.length > 1) return;
    const pos = cursor.head, line = state.doc.lineAt(pos);
    if (/^[\p{L}\p{N}_$]/u.test(state.doc.sliceString(pos, Math.min(line.to, pos + 1)))) return;
    const controller = new AbortController();
    this.controller = controller;
    try {
      const text = await config.suggest({
        prefix: state.doc.sliceString(Math.max(0, pos - PREFIX_CHARS), pos),
        suffix: state.doc.sliceString(pos, Math.min(state.doc.length, pos + SUFFIX_CHARS)),
      }, controller.signal);
      if (controller.signal.aborted || view.state.doc !== state.doc || view.state.selection.main.head !== pos) return;
      if (text) view.dispatch({ effects: setSuggestion.of({ from: pos, text }) });
    } catch (error) {
      if (!controller.signal.aborted) config.onError?.(error);
    } finally {
      if (this.controller === controller) this.controller = undefined;
    }
  }
  destroy() { this.cancel(); }
});

const ghostKeymap = Prec.highest(keymap.of([
  { key: "Tab", run: acceptSuggestion },
  { key: "Escape", run: dismissSuggestion },
  { key: "Mod-ArrowRight", run: acceptWord },
]));

/** Ghost text completions. The field, plugin and keymap are shared so a reconfigure keeps the current suggestion. */
export function ghostText(config: GhostOptions): Extension {
  return [options.of(config), suggestionField, ghostPlugin, ghostKeymap];
}
