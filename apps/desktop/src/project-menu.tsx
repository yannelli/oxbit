import { useEffect, useId, useRef, useState } from "react";
import type { WindowView } from "@oxbit/host-desktop";
import { Icon, translate as tr } from "@oxbit/ui";

export function ProjectMenu({
  view,
  onActivate,
  onOpen,
  onConnectSsh,
  onMove,
  onOpenBehaviorChange,
  disabled = false,
}: {
  view: WindowView;
  onActivate: (key: string) => void;
  onOpen: (newWindow?: boolean) => void;
  onConnectSsh: () => void;
  onMove?: () => void;
  onOpenBehaviorChange: (value: "currentWindow" | "newWindow") => void;
  disabled?: boolean;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const active = view.projects.find((entry) => entry.project.key === view.active);
  const behavior = view.profile.user["desktop.projects.openBehavior"] ?? "currentWindow";
  const items = () => Array.from(
    popup.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [],
  );
  const dismiss = (restoreFocus = false) => {
    popup.current?.hidePopover();
    if (restoreFocus) trigger.current?.focus();
  };
  const show = (last = false) => {
    const element = popup.current;
    if (disabled || !element || !trigger.current) return;
    const rect = trigger.current.getBoundingClientRect();
    const width = Math.min(340, innerWidth - 16);
    Object.assign(element.style, {
      width: `${width}px`,
      left: `${Math.max(8, Math.min(rect.left, innerWidth - width - 8))}px`,
      top: `${rect.bottom + 5}px`,
      maxHeight: `${Math.max(60, innerHeight - rect.bottom - 13)}px`,
    });
    element.showPopover();
    const buttons = items();
    (last ? buttons.at(-1) : buttons[0])?.focus();
  };
  const run = (action: () => void) => {
    dismiss(true);
    action();
  };
  useEffect(() => {
    if (disabled) popup.current?.hidePopover();
  }, [disabled]);
  useEffect(() => {
    const close = () => popup.current?.hidePopover();
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, []);
  return (
    <div className="desktop-project-control">
      <button
        ref={trigger}
        id="project-switcher"
        type="button"
        role="menuitem"
        className="workspace-title desktop-project-trigger"
        aria-label={`${tr("Projects")}: ${active?.project.name ?? tr("No folder open")}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        disabled={disabled}
        onClick={(event) => {
          event.stopPropagation();
          if (popup.current?.matches(":popover-open")) dismiss();
          else show();
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            event.stopPropagation();
            show(event.key === "ArrowUp");
          }
        }}
      >
        <Icon name="folder" size={14} />
        <span className="desktop-project-name">{active?.project.name ?? tr("Open a folder")}</span>
        {view.projects.length > 1 && (
          <span className="desktop-project-count" aria-hidden="true">{view.projects.length}</span>
        )}
        {(active?.failed || active?.error) && <Icon name="warning" size={14} />}
        <Icon name="chevD" size={12} />
      </button>
      <div
        ref={popup}
        id={id}
        className="command-menu desktop-project-menu"
        popover="auto"
        role="menu"
        aria-label={tr("Projects")}
        onToggle={(event) => setOpen(event.newState === "open")}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
            event.preventDefault();
            event.stopPropagation();
            const buttons = items();
            const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
            const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
              : (index + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length;
            buttons[next]?.focus();
          } else if (event.key === "Escape" || event.key === "Tab") {
            if (event.key === "Escape") event.preventDefault();
            event.stopPropagation();
            dismiss(true);
          }
        }}
      >
        {!!view.projects.length && (
          <>
            <div role="group" aria-label={tr("Open projects")}>
              <div className="desktop-project-heading">{tr("Open projects")}</div>
              {view.projects.map((entry) => (
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={entry.project.key === view.active}
                  className="desktop-project-row"
                  key={entry.project.key}
                  onClick={() => run(() => onActivate(entry.project.key))}
                >
                  <Icon name={entry.failed || entry.error ? "warning" : "folder"} size={16} />
                  <span className="desktop-project-detail">
                    <span>{entry.project.name}</span>
                    <small>{entry.project.path}</small>
                    {(entry.failed || entry.error) && <small className="desktop-project-warning">{tr("Needs attention")}</small>}
                  </span>
                  {entry.project.key === view.active && <Icon name="check" size={14} />}
                </button>
              ))}
            </div>
            <hr role="separator" />
          </>
        )}
        <button type="button" role="menuitem" onClick={() => run(onConnectSsh)}>
          <Icon name="goto" size={16} />
          <span>{tr("Connect over SSH…")}</span>
        </button>
        <button type="button" role="menuitem" onClick={() => run(() => onOpen())}>
          <Icon name="folderOpen" size={16} />
          <span>{tr("Open Folder…")}</span>
        </button>
        <button type="button" role="menuitem" onClick={() => run(() => onOpen(true))}>
          <Icon name="goto" size={16} />
          <span>{tr("Open in New Window…")}</span>
        </button>
        {onMove && (
          <button type="button" role="menuitem" onClick={() => run(onMove)}>
            <Icon name="splitR" size={16} />
            <span>{tr("Move to New Window")}</span>
          </button>
        )}
        <hr role="separator" />
        <div role="group" aria-label={tr("Open projects in")}>
          <div className="desktop-project-heading">{tr("Open projects in")}</div>
          {([ ["currentWindow", "Current window"], ["newWindow", "New window"] ] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="menuitemradio"
              aria-checked={behavior === value}
              className="desktop-project-row desktop-project-preference"
              onClick={() => run(() => onOpenBehaviorChange(value))}
            >
              <span>{tr(label)}</span>
              {behavior === value && <Icon name="check" size={14} />}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
