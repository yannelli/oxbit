import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Icon } from "./index.js";

type Option = { value: string; label: string; disabled?: boolean };
/** A themed select with native popover dismissal and listbox keyboard navigation. */
export function Select({
  value,
  options,
  onChange,
  label,
  disabled = false,
  className = "",
  icon,
  onOpen,
  openRequest = 0,
}: {
  value: string;
  options: Option[];
  onChange: (value: string) => void;
  label: string;
  disabled?: boolean;
  className?: string;
  icon?: string;
  onOpen?: () => void;
  openRequest?: number;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const typeahead = useRef({ text: "", time: 0 });
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(value);
  const enabled = options.filter((option) => !option.disabled);
  const current = options.find((option) => option.value === value);
  const activeIndex = options.findIndex((option) => option.value === active);
  function show() {
    if (disabled) return;
    setActive(
      enabled.some((option) => option.value === value)
        ? value
        : (enabled[0]?.value ?? ""),
    );
    setOpen(true);
    onOpen?.();
  }
  useEffect(() => {
    if (openRequest) {
      trigger.current?.focus();
      show();
    }
  }, [openRequest]);
  useEffect(() => {
    const element = popup.current;
    if (!open || !element) return;
    const position = () => {
      const rect = trigger.current!.getBoundingClientRect();
      const below = innerHeight - rect.bottom - 8;
      const above = rect.top - 8;
      const upward = below < 180 && above > below;
      const height = Math.min(288, upward ? above : below);
      const width = Math.min(Math.max(rect.width, 200), innerWidth - 16);
      Object.assign(element.style, {
        width: `${width}px`,
        maxHeight: `${Math.max(60, height)}px`,
        left: `${Math.max(8, Math.min(rect.left, innerWidth - width - 8))}px`,
        top: upward ? "auto" : `${rect.bottom + 4}px`,
        bottom: upward ? `${innerHeight - rect.top + 4}px` : "auto",
      });
    };
    position();
    element.showPopover();
    const dismiss = () => setOpen(false);
    window.addEventListener("resize", dismiss);
    return () => {
      element.hidePopover();
      window.removeEventListener("resize", dismiss);
    };
  }, [open]);
  useEffect(() => {
    if (open)
      popup.current
        ?.querySelector('[data-active="true"]')
        ?.scrollIntoView({ block: "nearest" });
  }, [open, active]);
  function choose(next: string) {
    onChange(next);
    setOpen(false);
    trigger.current?.focus();
  }
  function keydown(event: KeyboardEvent<HTMLButtonElement>) {
    const index = enabled.findIndex((option) => option.value === active);
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      if (!open) {
        show();
        return;
      }
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? enabled.length - 1
            : (index + (event.key === "ArrowDown" ? 1 : -1) + enabled.length) %
              enabled.length;
      if (enabled[next]) setActive(enabled[next].value);
    } else if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    } else if ((event.key === "Enter" || event.key === " ") && open) {
      event.preventDefault();
      event.stopPropagation();
      if (enabled.some((option) => option.value === active)) choose(active);
    } else if (event.key === "Tab") setOpen(false);
    else if (
      event.key.length === 1 &&
      event.key !== " " &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey
    ) {
      event.preventDefault();
      event.stopPropagation();
      const now = Date.now();
      const text =
        (now - typeahead.current.time < 700 ? typeahead.current.text : "") +
        event.key.toLowerCase();
      typeahead.current = { text, time: now };
      const match = enabled.find((option) =>
        option.label.toLowerCase().startsWith(text),
      );
      if (!open) show();
      if (match) setActive(match.value);
    }
  }
  return (
    <div className={`custom-select ${className}`}>
      <button
        ref={trigger}
        type="button"
        className="select-trigger"
        role="combobox"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={id}
        aria-activedescendant={
          open && activeIndex >= 0 ? `${id}-${activeIndex}` : undefined
        }
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={keydown}
      >
        {icon && <Icon name={icon} />}
        <span>{current?.label ?? value}</span>
        <Icon name="chevD" size={12} />
      </button>
      <div
        ref={popup}
        id={id}
        popover="auto"
        role="listbox"
        aria-label={label}
        className="select-popup"
        onToggle={(event) => {
          if (event.newState === "closed") setOpen(false);
        }}
      >
        {options.map((option, index) => (
          <div
            key={option.value}
            id={`${id}-${index}`}
            role="option"
            aria-selected={option.value === value}
            aria-disabled={option.disabled || undefined}
            data-active={option.value === active}
            className="select-option"
            onPointerMove={() => {
              if (!option.disabled) setActive(option.value);
            }}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              if (!option.disabled) choose(option.value);
            }}
          >
            <span>{option.label}</span>
            {option.value === value && <Icon name="check" size={14} />}
          </div>
        ))}
      </div>
    </div>
  );
}
