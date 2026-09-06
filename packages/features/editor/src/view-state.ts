import { EditorSelection, type EditorState } from "@codemirror/state";
import { foldedRanges } from "@codemirror/language";
import type { EditorView } from "@codemirror/view";
import type { DocumentViewState } from "@zapp/documents";
export function restoredSelection(
  saved: DocumentViewState | undefined,
  length: number,
) {
  if (!saved) return undefined;
  const clamp = (value: number) =>
    Math.max(0, Math.min(length, Number.isFinite(value) ? value : 0));
  const ranges = saved.selection?.ranges?.length
    ? saved.selection.ranges
    : [{ anchor: saved.anchor, head: saved.head }];
  return EditorSelection.create(
    ranges.map((range) =>
      EditorSelection.range(clamp(range.anchor), clamp(range.head)),
    ),
    Math.max(0, Math.min(ranges.length - 1, saved.selection?.main || 0)),
  );
}
export function savedFolds(state: EditorState) {
  const folds: { from: number; to: number }[] = [];
  for (let cursor = foldedRanges(state).iter(); cursor.value; cursor.next())
    folds.push({ from: cursor.from, to: cursor.to });
  return folds;
}
export function captureView(view: EditorView): DocumentViewState {
  return {
    anchor: view.state.selection.main.anchor,
    head: view.state.selection.main.head,
    selection: view.state.selection.toJSON(),
    scrollTop: view.scrollDOM.scrollTop,
    scrollLeft: view.scrollDOM.scrollLeft,
    folds: savedFolds(view.state),
  };
}
export const LARGE_DOCUMENT_LENGTH = 1024 * 1024;
export function detectedIndentation(
  content: string,
  size: number,
  spaces: boolean,
) {
  const leading = content
    .slice(0, 100000)
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => line.match(/^[\t ]+/)?.[0])
    .filter((value): value is string => !!value);
  if (leading.some((indent) => indent.startsWith("\t")))
    return { size, spaces: false };
  const widths = leading
    .map((indent) => indent.length)
    .filter((width) => width <= 8);
  return { size: widths.length ? Math.min(...widths) : size, spaces };
}
