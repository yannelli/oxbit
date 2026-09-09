import { languages, resolveLanguage, languageForKernel, type Kernel, type IconAsset, type IconThemes, type IconResource, type IconVariant } from "@oxbit/sdk";
import { translate as tr } from "./locale.js";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
  type ButtonHTMLAttributes,
  type ReactNode,
  type RefObject,
} from "react";
import { productIconIds } from "./product-icons.js";
import { icons } from "./icons.js";
import { TooltipLayer } from "./tooltips.js";
export { icons };
export { OxbitMark, OxbitLogo } from "./brand.js";
export { TooltipLayer };
const contributedIcons = createContext<Record<string, string>>({});
const iconThemeContext = createContext<{ service?: IconThemes; variant: IconVariant; kernel?: Kernel; version?: number }>({ variant: "dark" });
const noSubscribe = () => () => {};
const noSnapshot = () => 0;
export function IconProvider({ values, children, kernel, variant = "dark" }: {
  values: Record<string, string>; children: ReactNode; kernel?: Kernel; variant?: IconVariant;
}) {
  const service = kernel?.services.optional<IconThemes>("iconThemes");
  const version = useSyncExternalStore(service?.subscribe ?? noSubscribe, service?.snapshot ?? noSnapshot, noSnapshot);
  const selectedColor = kernel?.configuration?.get<string>("workbench.colorTheme");
  const color = kernel?.contributions?.list("theme").find(theme => theme.id === selectedColor || theme.title === selectedColor || (theme.data as { stableId?: string })?.stableId === selectedColor);
  if ((color?.data as { highContrast?: boolean })?.highContrast) variant = "highContrast";
  return <iconThemeContext.Provider value={{ service, variant, kernel, version }}><contributedIcons.Provider value={values}>{children}</contributedIcons.Provider></iconThemeContext.Provider>;
}
export function IconImage({ asset, size = 16 }: { asset: IconAsset; size?: number }) {
  const box = { width: size, height: size, flexShrink: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", verticalAlign: "middle" } as const;
  if (asset.kind === "image") return <img className="themed-icon" aria-hidden="true" alt="" draggable={false} src={asset.url} width={size} height={size} style={{ ...box, objectFit: "contain" }} />;
  if (asset.kind === "font") return <span className="themed-icon" aria-hidden="true" style={{ ...box, fontFamily: asset.family, fontSize: size * (parseFloat(asset.size ?? "100%") / 100), fontWeight: asset.weight ?? "normal", fontStyle: asset.style ?? "normal", color: asset.color ?? "currentColor", lineHeight: 1 }}>{asset.character}</span>;
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d={asset.path} /></svg>;
}
export function Icon({ name, size = 16 }: { name: string; size?: number }) {
  const custom = useContext(contributedIcons), { service } = useContext(iconThemeContext);
  const mapped = productIconIds[name];
  const asset = (mapped && service?.product(mapped)) || { kind: "path" as const, path: custom[name] || icons[name] || icons.files };
  return <IconImage asset={asset} size={size} />;
}
export function FolderIcon({ path, expanded = false, root = false }: { path: string; expanded?: boolean; root?: boolean }) {
  const { service, variant } = useContext(iconThemeContext);
  const custom = useContext(contributedIcons);
  const asset = service?.file({ path, expanded, root, folder: true }, variant);
  if (root && !asset) return null;
  return asset ? <IconImage asset={asset} /> : <IconImage asset={{ kind: "path", path: custom[expanded ? "folderOpen" : "folder"] || icons[expanded ? "folderOpen" : "folder"] }} />;
}
export function FolderArrow({ path, expanded = false, root = false }: { path: string; expanded?: boolean; root?: boolean }) {
  const { service, variant } = useContext(iconThemeContext);
  return service?.hideArrows({ path, root }, variant) ? null : <Icon name={expanded ? "chevD" : "chevR"} size={12} />;
}
export function IconButton({
  icon,
  label,
  title,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { icon: string; label: string }) {
  return (
    <button
      type="button"
      className="icon-button"
      aria-label={tr(label)}
      data-tooltip={tr(title ?? props["aria-label"] ?? label)}
      title=""
      {...props}
    >
      <Icon name={icon} />
    </button>
  );
}
export function FileBadge({ path, kernel }: { path: string; kernel?: Kernel }) {
  const context = useContext(iconThemeContext);
  const effectiveKernel = kernel ?? context.kernel;
  const definition = effectiveKernel ? languageForKernel(effectiveKernel, path) : resolveLanguage(path);
  const resource: IconResource = { path, languageId: definition.id };
  const asset = context.service?.file(resource, context.variant);
  if (asset) return <IconImage asset={asset} />;
  const preset = languages.find(item => item.id === definition.id);
  return <span className={`file-badge lang-${preset?.syntax ?? "plaintext"}`} aria-hidden="true">{preset?.badge ?? "≡"}</span>;
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
/** Keep touch surfaces inside the area left visible by browser chrome and the keyboard. */
export function useVisualViewport(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const element = ref.current;
    const ownerWindow = element?.ownerDocument.defaultView;
    const viewport = ownerWindow?.visualViewport;
    if (!element || !ownerWindow || !viewport) return;
    const update = () => {
      if (!ownerWindow.matchMedia("(pointer: coarse)").matches) return;
      // Pinch zoom must remain under the user's control.
      if (Math.abs(viewport.scale - 1) > 0.01) return;
      element.style.setProperty("--viewport-height", `${viewport.height}px`);
      element.style.setProperty("--viewport-offset", `${viewport.offsetTop}px`);
      element.style.setProperty("--viewport-left", `${viewport.offsetLeft}px`);
      element.style.setProperty("--viewport-width", `${viewport.width}px`);
      if (ownerWindow.innerHeight - viewport.height - viewport.offsetTop > 80)
        element.dataset.keyboard = "1";
      else delete element.dataset.keyboard;
    };
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    ownerWindow.addEventListener("resize", update);
    update();
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      ownerWindow.removeEventListener("resize", update);
      for (const property of ["--viewport-height", "--viewport-offset", "--viewport-left", "--viewport-width"])
        element.style.removeProperty(property);
      delete element.dataset.keyboard;
    };
  }, [ref]);
}
export function Dialog({
  title,
  children,
  onClose,
  danger = false,
  className = "",
  initialFocus,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  danger?: boolean;
  className?: string;
  initialFocus?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  useVisualViewport(scrimRef);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const prior = document.activeElement as HTMLElement | null;
    const el = ref.current;
    (initialFocus ? el?.querySelector<HTMLElement>(initialFocus) : undefined)?.focus();
    if (!initialFocus || !el?.contains(document.activeElement)) el?.querySelector<HTMLElement>(
      'input:not([hidden]),textarea,button,select,a[href],summary,[tabindex="0"]',
    )?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeRef.current();
      }
      if (e.key === "Tab" && el) {
        const list = Array.from(
          el.querySelectorAll<HTMLElement>(
            'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href],summary,[tabindex="0"]',
          ),
        ).filter(element => element.getClientRects().length > 0);
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
  }, [initialFocus]);
  return (
    <div
      ref={scrimRef}
      className="modal-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className={`dialog ${className}`.trim()}
        data-tooltip-root=""
        role={danger ? "alertdialog" : "dialog"}
        aria-modal="true"
        aria-label={tr(title)}
      >
        <div className="dialog-title">
          <strong>{tr(title)}</strong>
          <IconButton icon="x" label={tr("Close dialog")} onClick={onClose} />
        </div>
        {children}
        <TooltipLayer rootRef={ref} />
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

export { Select } from "./select.js";
export { IconThemeSelect } from "./icon-theme-select.js";
export { installTextInputPolicy } from "./text-input.js";
