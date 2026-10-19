import { EditorSelection, type EditorState } from "@codemirror/state";
import { foldedRanges } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import type { DocumentViewState } from "@oxbit/documents";
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
/** The view's selection, folds and scroll position. A detached or hidden view reports scrollTop 0, so it keeps the scroll from `previous`. */
export function captureView(view: EditorView, previous?: DocumentViewState): DocumentViewState {
  const laidOut = view.dom.isConnected && view.scrollDOM.clientHeight > 0;
  const block = laidOut ? view.lineBlockAtHeight(view.scrollDOM.scrollTop - view.documentPadding.top) : undefined;
  return {
    anchor: view.state.selection.main.anchor,
    head: view.state.selection.main.head,
    selection: view.state.selection.toJSON(),
    scrollTop: laidOut ? view.scrollDOM.scrollTop : previous?.scrollTop ?? 0,
    scrollLeft: laidOut ? view.scrollDOM.scrollLeft : previous?.scrollLeft ?? 0,
    ...(block ? { top: { pos: block.from, offset: view.scrollDOM.scrollTop - view.documentPadding.top - block.top } }
      : previous?.top ? { top: previous.top } : {}),
    folds: savedFolds(view.state),
  };
}

/** Scrolls back to a captured position. The line position survives height estimates that are not measured yet, which a pixel scrollTop does not. */
export function restoreScroll(view: EditorView, saved: DocumentViewState) {
  view.scrollDOM.scrollLeft = saved.scrollLeft || 0;
  if (saved.top && saved.top.pos <= view.state.doc.length)
    view.dispatch({ effects: EditorView.scrollIntoView(saved.top.pos, { y: "start", yMargin: -saved.top.offset }) });
  else view.scrollDOM.scrollTop = saved.scrollTop || 0;
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
