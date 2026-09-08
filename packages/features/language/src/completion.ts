import { snippet, pickedCompletion, type Completion } from "@codemirror/autocomplete";
import { EditorState, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { textOffset } from "@oxbit/sdk";
/** Apply list defaults before resolving or applying individual completion items. */
export function completionItems(value: any): any[] {
  const defaults = !Array.isArray(value) ? value?.itemDefaults ?? {} : {};
  return (Array.isArray(value) ? value : value?.items ?? []).filter((item: any) => typeof item?.label === "string").map((item: any, index: number) => {
    const normalized = { ...defaults, ...item, _index: index };
    if (!normalized.textEdit && defaults.editRange) normalized.textEdit = { ...(defaults.editRange.start ? { range: defaults.editRange } : defaults.editRange), newText: item.textEditText ?? item.insertText ?? item.label };
    return normalized;
  }).sort((a: any, b: any) => Number(Boolean(b.preselect)) - Number(Boolean(a.preselect)) || String(a.sortText ?? a.label).localeCompare(String(b.sortText ?? b.label)) || a._index - b._index);
}
/** CodeMirror understands numbered/default placeholders; normalize LSP's short stops and choices. */
export function snippetTemplate(value: string) {
  return value.replace(/\$\{(\d+)\|((?:\\.|[^|])*)\|\}/g, (_match, id, choices) => '${' + id + ':' + choices.split(/(?<!\\),/)[0].replace(/\\([,|\\])/g, '$1') + '}').replace(/(?<!\\)\$(\d+)/g, (_match, id) => '${' + id + '}');
}
export function completionTransactions(state: EditorState, item: any, completion: Completion, from: number, to: number) {
  const text = state.doc.toString(), range = item.textEdit?.range ?? item.textEdit?.insert ?? item.textEdit?.replace;
  const change = { from: range ? textOffset(text, range.start) : from, to: range ? textOffset(text, range.end) : to, insert: item.textEdit?.newText ?? item.insertText ?? item.label };
  const additional = (item.additionalTextEdits ?? []).map((edit: any) => ({ from: textOffset(text, edit.range.start), to: textOffset(text, edit.range.end), insert: edit.newText }));
  const ordered = [...additional, change].sort((a, b) => a.from - b.from || a.to - b.to);
  let end = -1;
  for (const edit of ordered) {
    if (edit.from < end || edit.from > edit.to || typeof edit.insert !== "string") throw new Error("Invalid or overlapping completion edits");
    end = edit.to;
  }
  if (state.readOnly || state.facet(EditorView.editable) === false) throw new Error("Document is read-only");
  if (item.insertTextFormat !== 2) return [state.update({ changes: ordered, selection: { anchor: change.from + change.insert.length + additional.filter((edit: any) => edit.to <= change.from).reduce((delta: number, edit: any) => delta + edit.insert.length - edit.to + edit.from, 0) }, annotations: [pickedCompletion.of(completion), Transaction.userEvent.of("input.complete")] })];
  const preceding = additional.length ? state.update({ changes: additional }) : undefined;
  let applied: Transaction | undefined;
  snippet(snippetTemplate(change.insert))({ state: preceding?.state ?? state, dispatch: transaction => { applied = transaction; } }, completion, preceding ? preceding.changes.mapPos(change.from, 1) : change.from, preceding ? preceding.changes.mapPos(change.to, 1) : change.to);
  return preceding ? [preceding, applied!] : [applied!];
}
