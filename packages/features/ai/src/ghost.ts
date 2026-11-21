import { Facet, Prec, StateEffect, StateField, type EditorState, type Extension, type Text, type Transaction } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap, type ViewUpdate } from "@codemirror/view";
import { translate as tr } from "@oxbit/ui";

export interface Suggestion {
  from: number;
  text: string;
  /** Shows the accept hint after the ghost text. */
  hint?: boolean;
}
export interface GhostOptions {
  /** Whether typing requests suggestions. Deleting and moving the cursor only dismiss; `requestSuggestion` works either way. */
  automatic(): boolean;
  delay(): number;
  /** Resolves to the cleaned suggestion for the cursor at `pos`, or "". */
  suggest(doc: Text, pos: number, signal: AbortSignal): Promise<string>;
  onError?(error: unknown): void;
}

export const setSuggestion = StateEffect.define<Suggestion | null>();
const setPending = StateEffect.define<number | null>();
/** Suggestions per session that show the "Tab to accept" hint. */
const HINT_LIMIT = 3;
let hintsShown = 0;
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
  return transaction.state.selection.main.empty && transaction.state.selection.main.head === from ? { ...value, from, text: value.text.slice(inserted.length) } : null;
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
    ? Decoration.set([Decoration.widget({ widget: new GhostWidget(value.text, value.hint === true), side: 1 }).range(value.from)])
    : Decoration.none),
});

/** The cursor position while a suggestion request is in flight. Edits and cursor moves clear it. */
const pendingField = StateField.define<number | null>({
  create: () => null,
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(setPending)) return effect.value;
    return value !== null && (transaction.docChanged || transaction.selection) ? null : value;
  },
  provide: (field) => EditorView.decorations.from(field, (pos) => pos === null
    ? Decoration.none
    : Decoration.set([Decoration.widget({ widget: new PendingWidget(), side: 1 }).range(pos)])),
});

class GhostWidget extends WidgetType {
  constructor(readonly text: string, readonly hint: boolean) { super(); }
  eq(other: GhostWidget) { return other.text === this.text && other.hint === this.hint; }
  toDOM() {
    const ghost = document.createElement("span");
    ghost.className = "cm-ai-ghost";
    ghost.setAttribute("aria-hidden", "true");
    ghost.textContent = this.text;
    if (!this.hint) return ghost;
    // The hint sits beside the ghost text so `.cm-ai-ghost` holds only the suggestion.
    const dom = document.createElement("span"), hint = document.createElement("span");
    dom.setAttribute("aria-hidden", "true");
    hint.className = "cm-ai-ghost-hint";
    hint.textContent = tr("Tab to accept");
    dom.append(ghost, hint);
    return dom;
  }
  ignoreEvent() { return true; }
}

class PendingWidget extends WidgetType {
  eq() { return true; }
  toDOM() {
    const dom = document.createElement("span");
    dom.className = "cm-ai-ghost-pending";
    dom.setAttribute("aria-hidden", "true");
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
    effects: setSuggestion.of(rest ? { ...value, from: value.from + word.length, text: rest } : null), userEvent: "input.complete" });
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
  destroyed = false;
  update(update: ViewUpdate) {
    if (!update.docChanged && !update.selectionSet) return;
    this.cancel();
    const typed = update.transactions.some((transaction) => transaction.isUserEvent("input.type"));
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
    view.dispatch({ effects: setPending.of(pos) });
    try {
      const text = await config.suggest(state.doc, pos, controller.signal);
      if (controller.signal.aborted || view.state.doc !== state.doc || view.state.selection.main.head !== pos) return;
      if (text) {
        const hint = hintsShown < HINT_LIMIT;
        if (hint) hintsShown++;
        view.dispatch({ effects: [setPending.of(null), setSuggestion.of({ from: pos, text, ...(hint ? { hint } : {}) }),
          EditorView.announce.of(tr("Suggestion available. Press Tab to accept."))] });
      }
    } catch (error) {
      if (!controller.signal.aborted) config.onError?.(error);
    } finally {
      if (this.controller === controller) this.controller = undefined;
      // Clears the marker unless a newer request owns it; edits clear it on their own.
      if (!this.destroyed && !this.controller && view.state.field(pendingField, false) === pos)
        view.dispatch({ effects: setPending.of(null) });
    }
  }
  destroy() {
    this.destroyed = true;
    this.cancel();
  }
});

const ghostKeymap = Prec.highest(keymap.of([
  { key: "Tab", run: acceptSuggestion },
  { key: "Escape", run: dismissSuggestion },
  { key: "Mod-ArrowRight", run: acceptWord },
]));

/** Ghost text completions. The field, plugin and keymap are shared so a reconfigure keeps the current suggestion. */
export function ghostText(config: GhostOptions): Extension {
  return [options.of(config), suggestionField, pendingField, ghostPlugin, ghostKeymap];
}
