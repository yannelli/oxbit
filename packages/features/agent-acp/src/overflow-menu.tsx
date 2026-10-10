import { useEffect, useId, useRef, useState } from "react";
import { Icon, translate as tr } from "@oxbit/ui";

export type MenuItem = { id: string; label: string; icon: string; run(): void };

/** Popover menu with the keyboard handling of the workbench panel menu. */
export function OverflowMenu({ label, items }: { label: string; items: MenuItem[] }) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const buttons = () =>
    Array.from(popup.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
  const dismiss = (restoreFocus = false) => {
    popup.current?.hidePopover();
    if (restoreFocus) trigger.current?.focus();
  };
  const show = (last = false) => {
    const element = popup.current;
    const button = trigger.current;
    const win = button?.ownerDocument.defaultView;
    if (!element || !button || !win) return;
    const rect = button.getBoundingClientRect();
    const width = Math.min(260, win.innerWidth - 16);
    const below = win.innerHeight - rect.bottom - 8;
    const above = rect.top - 8;
    const upward = below < 200 && above > below;
    Object.assign(element.style, {
      width: `${width}px`,
      left: `${Math.max(8, Math.min(rect.right - width, win.innerWidth - width - 8))}px`,
      top: upward ? "auto" : `${rect.bottom + 4}px`,
      bottom: upward ? `${win.innerHeight - rect.top + 4}px` : "auto",
      maxHeight: `${Math.max(60, upward ? above : below)}px`,
    });
    element.showPopover();
    const list = buttons();
    (last ? list.at(-1) : list[0])?.focus();
  };
  useEffect(() => {
    const win = trigger.current?.ownerDocument.defaultView;
    const close = () => popup.current?.hidePopover();
    win?.addEventListener("resize", close);
    return () => {
      close();
      win?.removeEventListener("resize", close);
    };
  }, []);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="icon-button"
        aria-label={tr(label)}
        data-tooltip={tr(label)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        onClick={(event) => {
          event.preventDefault();
          if (popup.current?.matches(":popover-open")) dismiss();
          else show();
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            show(event.key === "ArrowUp");
          }
        }}
      >
        <Icon name="more" />
      </button>
      <div
        ref={popup}
        id={id}
        className="command-menu panel-menu acp-menu"
        popover="auto"
        role="menu"
        aria-label={tr(label)}
        onToggle={(event) => setOpen(event.newState === "open")}
        onKeyDown={(event) => {
          if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
            event.preventDefault();
            const list = buttons();
            const index = list.indexOf(event.currentTarget.ownerDocument.activeElement as HTMLButtonElement);
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? list.length - 1
                  : (index + (event.key === "ArrowDown" ? 1 : list.length - 1)) % list.length;
            list[next]?.focus();
          } else if (event.key === "Escape" || event.key === "Tab") {
            if (event.key === "Escape") event.preventDefault();
            dismiss(true);
          }
        }}
      >
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            onClick={() => {
              dismiss(true);
              item.run();
            }}
          >
            <Icon name={item.icon} size={14} />
            <span>{tr(item.label)}</span>
          </button>
        ))}
      </div>
    </>
  );
}
