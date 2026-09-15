import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { translate as tr } from "@oxbit/ui";

export function ComposerInput({ value, commands, inputRef, onChange, onSend }: {
  value: string;
  commands: readonly { name: string; description: string }[];
  inputRef: RefObject<HTMLTextAreaElement | null>;
  onChange: (value: string) => void;
  onSend: () => void;
}) {
  const id = useId();
  const popup = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [caret, setCaret] = useState(0);
  const [selected, setSelected] = useState(0);
  const query = value.match(/^\/([^\s/]*)$/)?.[1];
  const matches = query === undefined ? [] : commands.filter((command) =>
    command.name.toLowerCase().startsWith(query.toLowerCase()));
  const open = focused && !dismissed && caret === value.length && matches.length > 0;
  const active = Math.min(selected, matches.length - 1);
  const choose = (name: string) => {
    const next = `/${name} `;
    onChange(next);
    setDismissed(true);
    inputRef.current?.focus();
    // React commits the controlled value before restoring the insertion point.
    inputRef.current?.ownerDocument.defaultView?.requestAnimationFrame(() => {
      inputRef.current?.setSelectionRange(next.length, next.length);
    });
  };
  useEffect(() => {
    const list = popup.current;
    const input = inputRef.current;
    const owner = input?.ownerDocument.defaultView;
    if (!open || !list || !input || !owner) return;
    const position = () => {
      const rect = input.getBoundingClientRect();
      const viewport = owner.visualViewport;
      const top = viewport?.offsetTop ?? 0;
      const left = viewport?.offsetLeft ?? 0;
      const width = viewport?.width ?? owner.innerWidth;
      const bottom = top + (viewport?.height ?? owner.innerHeight);
      const upward = rect.top - top >= bottom - rect.bottom;
      Object.assign(list.style, {
        width: `${Math.min(rect.width, width - 16)}px`,
        maxHeight: `${Math.max(0, Math.min(240, (upward ? rect.top - top : bottom - rect.bottom) - 12))}px`,
        left: `${Math.max(left + 8, Math.min(rect.left, left + width - rect.width - 8))}px`,
        top: upward ? "auto" : `${rect.bottom + 4}px`,
        bottom: upward ? `${owner.innerHeight - rect.top + 4}px` : "auto",
      });
    };
    position();
    list.showPopover();
    owner.addEventListener("resize", position);
    owner.addEventListener("scroll", position, true);
    owner.visualViewport?.addEventListener("resize", position);
    owner.visualViewport?.addEventListener("scroll", position);
    return () => {
      if (list.isConnected && list.matches(":popover-open")) list.hidePopover();
      owner.removeEventListener("resize", position);
      owner.removeEventListener("scroll", position, true);
      owner.visualViewport?.removeEventListener("resize", position);
      owner.visualViewport?.removeEventListener("scroll", position);
    };
  }, [open, inputRef]);
  useEffect(() => {
    if (open) popup.current?.children[active]?.scrollIntoView({ block: "nearest" });
  }, [open, active]);
  return <>
    <textarea
      ref={inputRef}
      data-local-submit
      aria-label={tr("Message agent")}
      aria-autocomplete="list"
      aria-haspopup="listbox"
      aria-controls={open ? id : undefined}
      aria-activedescendant={open ? `${id}-${active}` : undefined}
      placeholder={tr("Ask your agent to help with this workspace…")}
      value={value}
      onFocus={() => { setFocused(true); setDismissed(false); }}
      onBlur={() => setFocused(false)}
      onSelect={(event) => setCaret(event.currentTarget.selectionStart === event.currentTarget.selectionEnd
        ? event.currentTarget.selectionStart : -1)}
      onChange={(event) => {
        onChange(event.target.value);
        setCaret(event.target.selectionStart);
        setSelected(0);
        setDismissed(false);
      }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (open && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
          if (["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(event.key)) {
            event.preventDefault();
            event.stopPropagation();
            if (event.key === "Escape") setDismissed(true);
            else if (event.key === "ArrowDown" || event.key === "ArrowUp")
              setSelected((active + (event.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
            else choose(matches[active].name);
            return;
          }
        }
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          onSend();
        }
      }}
      rows={2}
    />
    <div ref={popup} id={id} popover="manual" className="acp-slash-commands"
      role="listbox" aria-label={tr("Agent slash commands")}>
      {matches.map((command, index) => <button
        key={command.name} id={`${id}-${index}`} type="button" role="option"
        tabIndex={-1} aria-selected={index === active}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => choose(command.name)}
      >
        <strong>/{command.name}</strong>
        <span>{command.description}</span>
      </button>)}
    </div>
  </>;
}
