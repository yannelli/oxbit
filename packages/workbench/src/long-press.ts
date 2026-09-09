/** Touch devices have no right button; a press held in place dispatches `contextmenu` so the
 * existing React handlers open their menus. Text surfaces keep the native selection callout. */
const EXCLUDED = 'input,textarea,select,[contenteditable="true"],.cm-content,.xterm';

export interface LongPressOptions {
  delay?: number;
  tolerance?: number;
}

export function installLongPress(root: HTMLElement, options: LongPressOptions = {}): () => void {
  const delay = options.delay ?? 500;
  const tolerance = options.tolerance ?? 8;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let origin: { pointerId: number; x: number; y: number } | undefined;
  let suppressClick = false;
  const cancel = () => {
    clearTimeout(timer);
    timer = undefined;
    origin = undefined;
  };
  const down = (event: PointerEvent) => {
    // A new gesture must never inherit suppression from a previous long press.
    suppressClick = false;
    cancel();
    if (event.pointerType !== "touch" || !event.isPrimary) return;
    const target = event.target as Element | null;
    if (!target || target.closest(EXCLUDED)) return;
    const { clientX, clientY } = event;
    origin = { pointerId: event.pointerId, x: clientX, y: clientY };
    timer = setTimeout(() => {
      timer = undefined;
      origin = undefined;
      // Suppress only the click belonging to a menu that actually opened.
      suppressClick = !target.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX, clientY, button: 2 }),
      );
    }, delay);
  };
  const move = (event: PointerEvent) => {
    if (!origin || event.pointerId !== origin.pointerId) return;
    if (Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > tolerance) cancel();
  };
  const cancelled = () => {
    cancel();
    suppressClick = false;
  };
  const click = (event: MouseEvent) => {
    if (!suppressClick) return;
    suppressClick = false;
    event.preventDefault();
    event.stopPropagation();
  };
  root.addEventListener("pointerdown", down);
  root.addEventListener("pointermove", move, { passive: true });
  root.addEventListener("pointerup", cancel);
  root.addEventListener("pointercancel", cancelled);
  root.addEventListener("click", click, true);
  return () => {
    cancel();
    root.removeEventListener("pointerdown", down);
    root.removeEventListener("pointermove", move);
    root.removeEventListener("pointerup", cancel);
    root.removeEventListener("pointercancel", cancelled);
    root.removeEventListener("click", click, true);
  };
}

/** True when the primary pointer is a finger; drag-and-drop and hover affordances change. */
export const coarsePointer = () =>
  typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
