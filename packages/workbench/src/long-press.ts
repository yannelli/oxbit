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
  let pointerId: number | undefined;
  let suppressClick = false;
  const cancel = () => {
    clearTimeout(timer);
    timer = undefined;
    pointerId = undefined;
  };
  const down = (event: PointerEvent) => {
    if (event.pointerType !== "touch" || !event.isPrimary) return;
    const target = event.target as Element | null;
    if (!target || target.closest(EXCLUDED)) return;
    cancel();
    pointerId = event.pointerId;
    const { clientX, clientY } = event;
    timer = setTimeout(() => {
      timer = undefined;
      pointerId = undefined;
      suppressClick = true;
      target.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX, clientY, button: 2 }),
      );
    }, delay);
    const origin = { x: clientX, y: clientY };
    const move = (moved: PointerEvent) => {
      if (moved.pointerId !== pointerId) return;
      if (Math.hypot(moved.clientX - origin.x, moved.clientY - origin.y) > tolerance) cancel();
    };
    root.addEventListener("pointermove", move, { passive: true });
    const done = () => {
      root.removeEventListener("pointermove", move);
      root.removeEventListener("pointerup", done);
      root.removeEventListener("pointercancel", done);
      cancel();
    };
    root.addEventListener("pointerup", done);
    root.addEventListener("pointercancel", done);
  };
  const click = (event: MouseEvent) => {
    if (!suppressClick) return;
    suppressClick = false;
    event.preventDefault();
    event.stopPropagation();
  };
  root.addEventListener("pointerdown", down);
  root.addEventListener("click", click, true);
  return () => {
    cancel();
    root.removeEventListener("pointerdown", down);
    root.removeEventListener("click", click, true);
  };
}

/** True when the primary pointer is a finger; drag-and-drop and hover affordances change. */
export const coarsePointer = () =>
  typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
