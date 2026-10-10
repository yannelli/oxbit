/** A touch that starts at the left or right screen edge and moves inward opens that side's panels.
 * Touch events are used because WebKit cancels pointer events once it starts panning. */
export interface EdgeSwipeOptions {
  edge?: number;
  distance?: number;
}

export function installEdgeSwipe(root: HTMLElement, open: (side: "left" | "right") => void, options: EdgeSwipeOptions = {}): () => void {
  const edge = options.edge ?? 20;
  const distance = options.distance ?? 40;
  let origin: { id: number; x: number; y: number; side: "left" | "right" } | undefined;
  const start = (event: TouchEvent) => {
    origin = undefined;
    const touch = event.touches.length === 1 ? event.touches[0] : undefined;
    if (!touch) return;
    const side = touch.clientX <= edge ? "left" : touch.clientX >= innerWidth - edge ? "right" : undefined;
    if (side) origin = { id: touch.identifier, x: touch.clientX, y: touch.clientY, side };
  };
  const move = (event: TouchEvent) => {
    const touch = origin && [...event.changedTouches].find(item => item.identifier === origin!.id);
    if (!origin || !touch) return;
    const inward = (touch.clientX - origin.x) * (origin.side === "left" ? 1 : -1);
    const vertical = Math.abs(touch.clientY - origin.y);
    if (vertical > 12 && vertical > inward) {
      origin = undefined;
      return;
    }
    if (inward <= vertical) return;
    event.preventDefault();
    if (inward < distance) return;
    const side = origin.side;
    origin = undefined;
    open(side);
  };
  const end = () => { origin = undefined; };
  root.addEventListener("touchstart", start, { passive: true });
  root.addEventListener("touchmove", move, { passive: false });
  root.addEventListener("touchend", end);
  root.addEventListener("touchcancel", end);
  return () => {
    root.removeEventListener("touchstart", start);
    root.removeEventListener("touchmove", move);
    root.removeEventListener("touchend", end);
    root.removeEventListener("touchcancel", end);
  };
}
