import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

/** One tooltip layer per workbench, outside scrollable toolbars and editor groups. */
export function TooltipLayer({
  rootRef,
  delay = 400,
  escapeBubbles = false,
}: {
  rootRef: RefObject<HTMLElement | null>;
  delay?: number;
  escapeBubbles?: boolean;
}) {
  const id = useId();
  const tipRef = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ anchor: HTMLElement; text: string } | null>(
    null,
  );
  const [position, setPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const ownerWindow = root.ownerDocument.defaultView!;
    setTip(null);
    let hovered: HTMLElement | null = null;
    let focused: HTMLElement | null = null;
    let active: HTMLElement | null = null;
    let shown = false;
    let dismissed: HTMLElement | null = null;
    let openTimer: ReturnType<typeof setTimeout> | undefined;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const clearTimers = () => {
      clearTimeout(openTimer);
      clearTimeout(closeTimer);
    };
    const hide = () => {
      clearTimers();
      active = null;
      shown = false;
      setTip(null);
    };
    const dismiss = () => {
      dismissed = active;
      hide();
    };
    const anchorAt = (target: EventTarget | null) => {
      const element = target as Element | null;
      if (element?.nodeType !== 1) return null;
      const anchor = element.closest<HTMLElement>(
        "[data-tooltip], button[aria-label]",
      );
      if (!anchor || !root.contains(anchor) || anchor.getAttribute("role") === "combobox") return null;
      if (anchor.closest("[data-tooltip-root]") !== root) return null;
      // Scrims and other invisible labeled buttons are not tooltip triggers.
      if (
        !anchor.hasAttribute("data-tooltip") &&
        !anchor.querySelector("svg, .dirty-dot")
      )
        return null;
      return anchor;
    };
    const insideTip = (target: EventTarget | null) =>
      !!target && "nodeType" in target && !!tipRef.current?.contains(target as Node);
    const resetDismissal = () => {
      if (dismissed !== hovered && dismissed !== focused) dismissed = null;
    };
    const show = (anchor: HTMLElement, delay: number) => {
      clearTimeout(closeTimer);
      resetDismissal();
      if (anchor === dismissed || (anchor === active && shown)) return;
      clearTimeout(openTimer);
      active = anchor;
      shown = false;
      setTip(null);
      openTimer = setTimeout(() => {
        const text =
          anchor.dataset.tooltip ?? anchor.getAttribute("aria-label");
        if (!root.contains(anchor) || !text?.trim()) {
          hide();
          return;
        }
        setPosition(null);
        shown = true;
        setTip({ anchor, text });
      }, delay);
    };
    const leave = () => {
      clearTimers();
      if (focused) show(focused, 0);
      else closeTimer = setTimeout(hide, 150);
    };
    const over = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      if (insideTip(event.target)) {
        clearTimeout(closeTimer);
        return;
      }
      resetDismissal();
      const anchor = anchorAt(event.target);
      if (anchor === hovered) return;
      hovered = anchor;
      if (anchor) show(anchor, delay);
    };
    const out = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      const next = anchorAt(event.relatedTarget);
      if (next === hovered && !insideTip(event.target)) return;
      hovered = next;
      resetDismissal();
      if (insideTip(event.relatedTarget)) {
        clearTimeout(closeTimer);
        return;
      }
      if (next) show(next, delay);
      else leave();
    };
    const focus = (event: FocusEvent) => {
      const anchor = anchorAt(event.target);
      if (anchor?.matches(":focus-visible")) {
        focused = anchor;
        show(anchor, 0);
      }
    };
    const blur = () => {
      focused = null;
      resetDismissal();
      if (hovered) show(hovered, delay);
      else leave();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && active) {
        // A dialog/popover owns Escape when the tooltip belongs to something outside it.
        const dialog = (event.target as Element | null)?.nodeType === 1 ? (event.target as Element).closest('[role="dialog"], [role="alertdialog"], [popover]') : null;
        if (!escapeBubbles && (!dialog || dialog.contains(active)))
          event.stopPropagation();
        event.preventDefault();
        dismiss();
      }
    };
    root.addEventListener("pointerover", over);
    root.addEventListener("pointerout", out);
    root.addEventListener("focusin", focus);
    root.addEventListener("focusout", blur);
    root.addEventListener("pointerdown", dismiss, true);
    // Hover does not move focus into the workbench, so Escape may target the body.
    ownerWindow.addEventListener("keydown", key, true);
    ownerWindow.addEventListener("scroll", dismiss, true);
    ownerWindow.addEventListener("resize", dismiss);
    ownerWindow.addEventListener("blur", dismiss);
    const observer = new MutationObserver(() => {
      if (active && !root.contains(active)) hide();
    });
    observer.observe(root, { childList: true, subtree: true });
    return () => {
      clearTimers();
      observer.disconnect();
      root.removeEventListener("pointerover", over);
      root.removeEventListener("pointerout", out);
      root.removeEventListener("focusin", focus);
      root.removeEventListener("focusout", blur);
      root.removeEventListener("pointerdown", dismiss, true);
      ownerWindow.removeEventListener("keydown", key, true);
      ownerWindow.removeEventListener("scroll", dismiss, true);
      ownerWindow.removeEventListener("resize", dismiss);
      ownerWindow.removeEventListener("blur", dismiss);
    };
  }, [rootRef, delay, escapeBubbles]);

  useLayoutEffect(() => {
    const element = tipRef.current;
    const root = rootRef.current;
    if (!tip || !element || !root) return;
    const anchor = tip.anchor.getBoundingClientRect();
    const bounds = root.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    const leftEdge = Math.max(0, bounds.left) + 8;
    const rightEdge = Math.min(root.ownerDocument.defaultView!.innerWidth, bounds.right) - 8;
    const topEdge = Math.max(0, bounds.top) + 8;
    const bottomEdge = Math.min(root.ownerDocument.defaultView!.innerHeight, bounds.bottom) - 8;
    const below = anchor.bottom + 6;
    setPosition({
      left: Math.max(
        leftEdge,
        Math.min(
          anchor.left + (anchor.width - rect.width) / 2,
          rightEdge - rect.width,
        ),
      ),
      top: Math.max(
        topEdge,
        Math.min(
          below + rect.height <= bottomEdge
            ? below
            : anchor.top - rect.height - 6,
          bottomEdge - rect.height,
        ),
      ),
    });
    const descriptions = new Set(
      (tip.anchor.getAttribute("aria-describedby") || "")
        .split(/\s+/)
        .filter(Boolean),
    );
    descriptions.add(id);
    tip.anchor.setAttribute("aria-describedby", [...descriptions].join(" "));
    return () => {
      const remaining = (tip.anchor.getAttribute("aria-describedby") || "")
        .split(/\s+/)
        .filter((value) => value && value !== id);
      if (remaining.length)
        tip.anchor.setAttribute("aria-describedby", remaining.join(" "));
      else tip.anchor.removeAttribute("aria-describedby");
    };
  }, [tip, id, rootRef]);

  return tip ? (
    <div
      ref={tipRef}
      id={id}
      role="tooltip"
      className="workbench-tooltip"
      style={{
        left: position?.left ?? 0,
        top: position?.top ?? 0,
        visibility: position ? "visible" : "hidden",
      }}
    >
      {tip.text}
    </div>
  ) : null;
}
