import {
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import { Icon, translate as tr } from "@oxbit/ui";
import { insertMention, mentionQuery, type Mention } from "./mentions.js";
import { imageFiles } from "./images.js";
import { sendHint, sendsOnKey, useSendMode } from "./send-keys.js";
import type { ConfigurationService } from "@oxbit/sdk";

export interface ComposerActions {
  insertSlash(): void;
}
type Item = { key: string; label: ReactNode; detail?: string; choose: () => void };

export function SendHint({ configuration }: { configuration: ConfigurationService }) {
  const hint = sendHint(useSendMode(configuration));
  return hint ? <span className="muted acp-hint">{tr(hint)}</span> : null;
}

function slashQuery(value: string, caret: number) {
  const match = /^\/([^\s/]*)$/.exec(value.slice(0, caret));
  return match && !/^\S/.test(value.slice(caret)) ? match[1] : undefined;
}

export function ComposerInput({
  value, commands, inputRef, actionsRef, configuration, onChange, onSend, onEscape, onMention, onImages, findFiles,
}: {
  value: string;
  commands: readonly { name: string; description: string }[];
  inputRef: RefObject<HTMLTextAreaElement | null>;
  actionsRef?: Ref<ComposerActions>;
  configuration: ConfigurationService;
  onChange: (value: string) => void;
  onSend: () => void;
  /** Returns true when Escape stopped something. */
  onEscape?: () => boolean;
  onMention: (mention: Mention) => void;
  onImages: (files: File[]) => void;
  findFiles: (query: string, signal: AbortSignal) => Promise<string[]>;
}) {
  const id = useId();
  const mode = useSendMode(configuration);
  const popup = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [caret, setCaret] = useState(0);
  const [selected, setSelected] = useState(0);
  const [found, setFound] = useState<{ query: string; paths: string[] }>({ query: "", paths: [] });
  const place = (next: string, at: number) => {
    onChange(next);
    setCaret(at);
    inputRef.current?.focus();
    // React commits the controlled value before restoring the insertion point.
    inputRef.current?.ownerDocument.defaultView?.requestAnimationFrame(() => {
      inputRef.current?.setSelectionRange(at, at);
    });
  };
  const command = caret >= 0 ? slashQuery(value, caret) : undefined;
  const mention = command === undefined && caret >= 0 ? mentionQuery(value, caret) : undefined;
  let items: Item[] = [];
  if (command !== undefined)
    items = commands
      .filter((item) => item.name.toLowerCase().startsWith(command.toLowerCase()))
      .map((item) => ({
        key: item.name,
        label: <strong>/{item.name}</strong>,
        detail: item.description,
        choose: () => {
          const rest = value.slice(caret).replace(/^\s+/, "");
          const head = `/${item.name} `;
          place(head + rest, head.length);
          setDismissed(true);
        },
      }));
  else if (mention) {
    const pick = (chosen: Mention) => {
      if (chosen.kind === "file") {
        const next = insertMention(value, mention.start, caret, chosen.path);
        place(next.value, next.caret);
      } else {
        const end = mention.start + mention.query.length + 1;
        place(value.slice(0, mention.start) + value.slice(end), mention.start);
      }
      setDismissed(true);
      onMention(chosen);
    };
    const term = mention.query.toLowerCase();
    items = ([["selection", "Selection", "focus"], ["diagnostics", "Diagnostics", "warning"]] as const)
      .filter(([, label]) => tr(label).toLowerCase().includes(term) || label.toLowerCase().includes(term))
      .map(([kind, label, icon]): Item => ({
        key: kind,
        label: <strong><Icon name={icon} size={14} /> {tr(label)}</strong>,
        detail: tr(kind === "selection" ? "Attach the editor selection" : "Attach the active file's diagnostics"),
        choose: () => pick({ kind }),
      }))
      .concat(found.query === mention.query ? found.paths.map((path) => ({
        key: path,
        label: <strong>{path.slice(path.lastIndexOf("/") + 1)}</strong>,
        detail: path,
        choose: () => pick({ kind: "file", path }),
      })) : []);
  }
  const mentionTerm = mention?.query;
  const search = useRef(findFiles);
  search.current = findFiles;
  useEffect(() => {
    if (!mentionTerm) return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      search.current(mentionTerm, abort.signal).then(
        (paths) => { if (!abort.signal.aborted) setFound({ query: mentionTerm, paths }); },
        () => {},
      );
    }, 120);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [mentionTerm]);
  useImperativeHandle(actionsRef, () => ({
    insertSlash() {
      const rest = value.replace(/^\s+/, "");
      setDismissed(false);
      setSelected(0);
      place(rest ? `/ ${rest}` : "/", 1);
    },
  }));
  const open = focused && !dismissed && items.length > 0;
  const active = Math.min(selected, items.length - 1);
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
      enterKeyHint={mode.coarse ? "enter" : "send"}
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
      onPaste={(event) => {
        const files = imageFiles(event.clipboardData);
        if (!files.length) return;
        event.preventDefault();
        onImages(files);
      }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (open && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
          if (["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(event.key)) {
            event.preventDefault();
            event.stopPropagation();
            if (event.key === "Escape") setDismissed(true);
            else if (event.key === "ArrowDown" || event.key === "ArrowUp")
              setSelected((active + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length);
            else items[active].choose();
            return;
          }
        }
        if (event.key === "Escape" && onEscape?.()) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (sendsOnKey(event, mode)) {
          event.preventDefault();
          onSend();
        }
      }}
      rows={2}
    />
    <div ref={popup} id={id} popover="manual" className="acp-slash-commands"
      role="listbox" aria-label={tr(command !== undefined ? "Agent slash commands" : "Mention files and context")}>
      {open && items.map((item, index) => <button
        key={item.key} id={`${id}-${index}`} type="button" role="option"
        tabIndex={-1} aria-selected={index === active}
        onMouseDown={(event) => event.preventDefault()}
        onClick={item.choose}
      >
        {item.label}
        {item.detail && <span>{item.detail}</span>}
      </button>)}
    </div>
  </>;
}
