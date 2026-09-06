import { translate as tr } from "./locale.js";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import { icons } from "./icons.js";
export { icons };
const contributedIcons = createContext<Record<string, string>>({});
export function IconProvider({
  values,
  children,
}: {
  values: Record<string, string>;
  children: ReactNode;
}) {
  return (
    <contributedIcons.Provider value={values}>
      {children}
    </contributedIcons.Provider>
  );
}
export function Icon({ name, size = 16 }: { name: string; size?: number }) {
  const custom = useContext(contributedIcons);
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={custom[name] || icons[name] || icons.files} />
    </svg>
  );
}
export function IconButton({
  icon,
  label,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { icon: string; label: string }) {
  return (
    <button
      type="button"
      className="icon-button"
      aria-label={tr(label)}
      title={tr(label)}
      {...props}
    >
      <Icon name={icon} />
    </button>
  );
}
export function FileBadge({ path }: { path: string }) {
  const ext = path.split(".").pop() || "txt";
  const labels: Record<string, string> = {
    ts: "TS",
    tsx: "TX",
    js: "JS",
    jsx: "JX",
    json: "{}",
    css: "#",
    html: "<>",
    md: "M↓",
  };
  return (
    <span className={`file-badge lang-${ext}`} aria-hidden="true">
      {labels[ext] || "≡"}
    </span>
  );
}
export function EmptyState({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <Icon name="info" size={28} />
      <strong>{tr(title)}</strong>
      {children}
    </div>
  );
}
export function Dialog({
  title,
  children,
  onClose,
  danger = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  danger?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prior = document.activeElement as HTMLElement | null;
    const el = ref.current;
    el?.querySelector<HTMLElement>(
      'input,button,select,[tabindex="0"]',
    )?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
      if (e.key === "Tab" && el) {
        const list = Array.from(
          el.querySelectorAll<HTMLElement>(
            'button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]',
          ),
        );
        const a = list[0],
          b = list.at(-1);
        if (e.shiftKey && document.activeElement === a) {
          e.preventDefault();
          b?.focus();
        } else if (!e.shiftKey && document.activeElement === b) {
          e.preventDefault();
          a?.focus();
        }
      }
    };
    el?.addEventListener("keydown", key);
    return () => {
      el?.removeEventListener("keydown", key);
      prior?.focus();
    };
  }, [onClose]);
  return (
    <div
      className="modal-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className="dialog"
        role={danger ? "alertdialog" : "dialog"}
        aria-modal="true"
        aria-label={tr(title)}
      >
        <div className="dialog-title">
          <strong>{tr(title)}</strong>
          <IconButton icon="x" label={tr("Close dialog")} onClick={onClose} />
        </div>
        {children}
      </div>
    </div>
  );
}
export class UserCancelled extends Error {
  constructor() {
    super("Cancelled");
  }
}

export { translate, setLocale, getLocale, getPhrases } from "./locale.js";
