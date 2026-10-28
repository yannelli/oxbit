import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Dialog, Icon, translate as tr } from "@oxbit/ui";
import type { WorkbenchController } from "./controller.js";
import type { ViewBadge } from "./controller.js";
import { badgeLabel, useWorkbench, ViewBadgeMark, viewIcon } from "./index.js";

const panelIcons: Record<string, string> = {
  terminal: "terminal", problems: "warning", output: "menu", tasks: "tasks",
};
const panelOrder = ["explorer", "search", "scm", "extensions", "terminal", "problems", "output", "tasks"];

export function PanelSwitcher({ workbench, title, navigation = false, barViews, badge, settingsActive = false, onSettings, children }: {
  workbench: WorkbenchController;
  title?: string;
  navigation?: boolean;
  barViews?: string[];
  badge?: ViewBadge;
  settingsActive?: boolean;
  onSettings?: () => void;
  children?: ReactNode;
}) {
  useWorkbench(workbench);
  const [open, setOpen] = useState(false);
  const [iosPhone, setIosPhone] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const button = trigger.current;
    const viewport = button?.ownerDocument.defaultView?.matchMedia("(max-width: 599px)");
    if (!navigation || !button || !viewport) return;
    const update = () => setIosPhone(viewport.matches && !!button.closest(".ios-shell"));
    update();
    viewport.addEventListener("change", update);
    return () => viewport.removeEventListener("change", update);
  }, [navigation]);
  const panels = workbench.kernel.contributions.list().filter(item =>
    ["activityView", "panel"].includes(item.kind) && item.component && workbench.kernel.context.matches(item.when),
  ).sort((a, b) => {
    const aIndex = panelOrder.indexOf(a.id), bIndex = panelOrder.indexOf(b.id);
    return (aIndex < 0 ? panelOrder.length : aIndex) - (bIndex < 0 ? panelOrder.length : bIndex);
  });
  const active = panels.filter(item => workbench.panelVisible(item.id));
  const primaryViews = (barViews ?? ["explorer", "search", "scm", "extensions"]).filter(id => !iosPhone || !["search", "extensions"].includes(id));
  const extraActive = active.some(item => !primaryViews.includes(item.id)) || settingsActive;
  return <>
    <button
      ref={trigger}
      type="button"
      className={navigation ? `panel-switcher-nav ${open || extraActive ? "active" : ""}` : "panel-switcher-trigger"}
      aria-label={badgeLabel(tr(navigation ? "More" : "Switch panel"), badge)}
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={event => { event.currentTarget.focus({ preventScroll: true }); setOpen(true); }}
    >
      {navigation ? <><Icon name="more" /><ViewBadgeMark badge={badge} /><span className="phone-label">{tr("More view")}</span></>
        : <><span className="truncate">{title}</span><Icon name="chevD" size={14} /></>}
    </button>
    {open && createPortal(<Dialog title={tr("Panels")} className="panel-switcher-dialog" onClose={() => setOpen(false)}>
      <button className="panel-switcher-editor" onClick={() => {
        setOpen(false);
        workbench.set({ panelOverlay: false });
      }}>
        <Icon name="files" /><span>{tr("Back to editor")}</span><Icon name="chevR" />
      </button>
      <div className="panel-switcher-grid">
        {panels.map(item => <button key={item.id} aria-pressed={workbench.panelVisible(item.id)} onClick={() => {
          setOpen(false);
          workbench.openPanel(item.id);
        }}>
          <Icon name={panelIcons[item.id] ?? viewIcon(item)} />
          <span>{tr(item.title)}</span>
          {workbench.panelVisible(item.id) && <Icon name="check" size={14} />}
        </button>)}
        {onSettings && <button aria-pressed={settingsActive} onClick={() => {
          setOpen(false);
          onSettings();
        }}>
          <Icon name="gear" />
          <span>{tr("Settings")}</span>
          {settingsActive && <Icon name="check" size={14} />}
        </button>}
      </div>
      {children}
      <button className="panel-switcher-commands" onClick={() => {
        setOpen(false);
        workbench.openPalette();
      }}><Icon name="search" /><span>{tr("Show All Commands")}</span><Icon name="chevR" /></button>
    </Dialog>, trigger.current?.closest(".workbench") ?? document.body)}
  </>;
}
