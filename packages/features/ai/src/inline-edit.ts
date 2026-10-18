import { Prec, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, keymap } from "@codemirror/view";
import { EDIT_SYSTEM, PREFIX_CHARS, SUFFIX_CHARS, cleanEdit, editPrompt } from "./prompt.js";
import type { AiService } from "./service.js";

export const MAX_EDIT_CHARS = 100_000;
const EDIT_MAX_TOKENS = 8192;

interface Range { from: number; to: number }
interface EditMarks { pending?: Range; applied?: Range }

const setMarks = StateEffect.define<EditMarks>();
/** The selection while a request runs, then the inserted text until the next change. */
export const editMarks = StateField.define<EditMarks>({
  create: () => ({}),
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(setMarks)) return effect.value;
    if (!transaction.docChanged) return value;
    const map = (range: Range) => ({ from: transaction.changes.mapPos(range.from, 1), to: transaction.changes.mapPos(range.to, -1) });
    return value.pending ? { pending: map(value.pending) } : {};
  },
  provide: (field) => EditorView.decorations.from(field, ({ pending, applied }) => {
    const range = pending ?? applied;
    if (!range || range.from >= range.to) return Decoration.none;
    return Decoration.set([Decoration.mark({ class: pending ? "cm-ai-edit-pending" : "cm-ai-edit-applied" }).range(range.from, range.to)]);
  }),
});

const requests = new WeakMap<EditorView, AbortController>();

export function cancelInlineEdit(view: EditorView) {
  const controller = requests.get(view);
  if (!controller) return false;
  controller.abort();
  return true;
}

const theme = EditorView.baseTheme({
  ".cm-ai-edit-pending": { backgroundColor: "var(--accent-soft)", animation: "cm-ai-pulse 1.2s ease-in-out infinite" },
  ".cm-ai-edit-applied": { backgroundColor: "var(--add-soft)" },
  "@keyframes cm-ai-pulse": { "50%": { opacity: ".55" } },
});

export const inlineEditExtension: Extension = [editMarks, theme, Prec.highest(keymap.of([{ key: "Escape", run: cancelInlineEdit }]))];

export interface InlineEditInput {
  view: EditorView;
  service: AiService;
  instruction: string;
  path: string;
  language?: string;
  /** Ends the current undo group, so the edit undoes separately from nearby typing. */
  isolateUndo?: () => void;
}

/** Rewrites the main selection, or inserts at the cursor, as one undoable change. Resolves to whether it applied. */
export async function runInlineEdit({ view, service, instruction, path, language, isolateUndo }: InlineEditInput) {
  const { from, to } = view.state.selection.main;
  if (to - from > MAX_EDIT_CHARS) throw new Error(`Select at most ${MAX_EDIT_CHARS.toLocaleString()} characters for an AI edit`);
  if (view.state.readOnly) throw new Error("This file is read-only");
  requests.get(view)?.abort();
  const controller = new AbortController();
  requests.set(view, controller);
  const doc = view.state.doc, selection = doc.sliceString(from, to);
  view.dispatch({ effects: setMarks.of({ pending: { from, to } }) });
  try {
    const reply = await service.complete({
      system: EDIT_SYSTEM,
      prompt: editPrompt({ path, language, instruction, selection,
        prefix: doc.sliceString(Math.max(0, from - PREFIX_CHARS), from),
        suffix: doc.sliceString(to, Math.min(doc.length, to + SUFFIX_CHARS)) }),
      maxTokens: EDIT_MAX_TOKENS,
    }, controller.signal);
    if (controller.signal.aborted || !view.dom.isConnected) return false;
    const range = view.state.field(editMarks, false)?.pending;
    if (!range || view.state.doc.sliceString(range.from, range.to) !== selection)
      throw new Error("The selection changed while the AI edit ran; nothing was applied");
    const insert = cleanEdit(reply, selection);
    isolateUndo?.();
    view.dispatch({
      changes: { from: range.from, to: range.to, insert },
      selection: { anchor: range.from, head: range.from + insert.length },
      effects: setMarks.of({ applied: { from: range.from, to: range.from + insert.length } }),
      userEvent: "input.ai", scrollIntoView: true,
    });
    isolateUndo?.();
    return true;
  } catch (error) {
    if (controller.signal.aborted) return false;
    throw error;
  } finally {
    if (requests.get(view) === controller) requests.delete(view);
    if (view.dom.isConnected && view.state.field(editMarks, false)?.pending) view.dispatch({ effects: setMarks.of({}) });
  }
}
