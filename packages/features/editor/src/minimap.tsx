import { EditorView } from "@codemirror/view";
import { translate as tr } from "@oxbit/ui";
import { useEffect, useRef, type PointerEvent } from "react";

/** Row height in CSS pixels before the document is compressed to fit the canvas. */
const ROW = 2;
const CHAR = 0.7;
const LINE_ALPHA = 0.35;
const VIEWPORT_ALPHA = 0.14;
const repaints = new WeakMap<EditorView, () => void>();

/** Repaints the view's minimap after edits, folds and height changes. */
export const minimapListener = EditorView.updateListener.of((update) => {
  if (update.docChanged || update.geometryChanged || update.heightChanged)
    repaints.get(update.view)?.();
});

const rowHeight = (view: EditorView, height: number) =>
  Math.min(ROW, height / Math.max(1, view.state.doc.lines));

/** Distance from the top of the scrolled content to the top of the document. */
function documentOffset(view: EditorView) {
  const scroller = view.scrollDOM;
  return view.documentTop - scroller.getBoundingClientRect().top + scroller.scrollTop;
}

/** Fractional zero-based line index at document height `y`; folded blocks spread over their lines. */
function lineIndexAt(view: EditorView, y: number) {
  const doc = view.state.doc, block = view.lineBlockAtHeight(y);
  const first = doc.lineAt(block.from).number, last = doc.lineAt(block.to).number;
  const fraction = block.height > 0 ? Math.min(1, Math.max(0, (y - block.top) / block.height)) : 0;
  return first - 1 + fraction * (last - first + 1);
}

/** The visible part of the editor as a band in canvas pixels. */
function viewportBand(view: EditorView, height: number) {
  const row = rowHeight(view, height), scroller = view.scrollDOM;
  const end = view.lineBlockAt(view.state.doc.length).bottom;
  const start = Math.min(end, Math.max(0, scroller.scrollTop - documentOffset(view)));
  const stop = Math.min(end, start + scroller.clientHeight);
  return { row, top: lineIndexAt(view, start) * row, bottom: lineIndexAt(view, stop) * row };
}

/** Scrolls so the top of the editor shows the fractional line `index`. */
function scrollToLine(view: EditorView, index: number) {
  const doc = view.state.doc, clamped = Math.max(0, Math.min(doc.lines, index));
  const line = doc.line(Math.min(doc.lines, Math.floor(clamped) + 1));
  const block = view.lineBlockAt(line.from);
  const first = doc.lineAt(block.from).number, last = doc.lineAt(block.to).number;
  const fraction = Math.min(1, (clamped - (first - 1)) / (last - first + 1));
  view.scrollDOM.scrollTop = block.top + fraction * block.height + documentOffset(view);
}

function paint(canvas: HTMLCanvasElement, view: EditorView) {
  const width = canvas.clientWidth, height = canvas.clientHeight, ratio = window.devicePixelRatio || 1;
  if (!width || !height) return;
  const pixelWidth = Math.round(width * ratio), pixelHeight = Math.round(height * ratio);
  if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = getComputedStyle(canvas).color;
  ctx.globalAlpha = LINE_ALPHA;
  const row = rowHeight(view, height), stroke = Math.max(0.5, row / 2);
  let y = 0;
  for (const lines = view.state.doc.iterLines(); !lines.next().done; y += row) {
    const text = lines.value, length = text.trim().length;
    if (!length) continue;
    const x = Math.min(width, (/^\s*/.exec(text)?.[0].length ?? 0) * CHAR);
    const span = Math.min(width - 6 - x, length * CHAR);
    if (span > 0) ctx.fillRect(x, y, span, stroke);
  }
  const band = viewportBand(view, height);
  const top = band.top, size = Math.max(4, band.bottom - band.top);
  ctx.globalAlpha = VIEWPORT_ALPHA;
  ctx.fillRect(0, top, width, size);
  ctx.globalAlpha = VIEWPORT_ALPHA * 2;
  ctx.fillRect(0, top, width, 1);
  ctx.fillRect(0, top + size - 1, width, 1);
  ctx.globalAlpha = 1;
}

export function Minimap({ view }: { view: EditorView | null }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const schedule = useRef<() => void>(() => undefined);
  const grab = useRef<number | undefined>(undefined);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !view) return;
    let frame = 0;
    const repaint = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        paint(canvas, view);
      });
    };
    schedule.current = repaint;
    repaints.set(view, repaint);
    view.scrollDOM.addEventListener("scroll", repaint, { passive: true });
    const resize = typeof ResizeObserver === "function" ? new ResizeObserver(repaint) : undefined;
    resize?.observe(canvas);
    resize?.observe(view.scrollDOM);
    repaint();
    return () => {
      cancelAnimationFrame(frame);
      schedule.current = () => undefined;
      if (repaints.get(view) === repaint) repaints.delete(view);
      view.scrollDOM.removeEventListener("scroll", repaint);
      resize?.disconnect();
    };
  }, [view]);
  // Theme and setting changes re-render the editor; pick up new colors.
  useEffect(() => schedule.current());
  const pointerY = (event: PointerEvent<HTMLCanvasElement>) =>
    event.clientY - event.currentTarget.getBoundingClientRect().top;
  const drag = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!view || grab.current === undefined) return;
    const row = rowHeight(view, event.currentTarget.clientHeight);
    scrollToLine(view, (pointerY(event) - grab.current) / row);
  };
  const release = () => { grab.current = undefined; };
  return (
    <canvas
      aria-label={tr("Document minimap")}
      className="minimap"
      ref={ref}
      onPointerDown={(event) => {
        if (!view || event.button !== 0) return;
        event.preventDefault();
        const y = pointerY(event), band = viewportBand(view, event.currentTarget.clientHeight);
        const inside = y >= band.top && y <= Math.max(band.bottom, band.top + 4);
        grab.current = inside ? y - band.top : (band.bottom - band.top) / 2;
        event.currentTarget.setPointerCapture?.(event.pointerId);
        drag(event);
      }}
      onPointerMove={drag}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={release}
    />
  );
}
