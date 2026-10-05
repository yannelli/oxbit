import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Dialog, Icon, translate as tr } from "@oxbit/ui";
import type { WorkbenchController } from "./controller.js";
import { useWorkbench, viewIcon } from "./index.js";

const panelIcons: Record<string, string> = {
  terminal: "terminal", problems: "warning", output: "menu", tasks: "tasks",
};
const panelOrder = ["explorer", "search", "scm", "extensions", "terminal", "problems", "output", "tasks"];

export function PanelSwitcher({ workbench, title, navigation = false }: {
  workbench: WorkbenchController;
  title?: string;
  navigation?: boolean;
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
  const primaryViews = iosPhone ? ["explorer", "scm"] : ["explorer", "search", "scm", "extensions"];
  const extraActive = active.some(item => !primaryViews.includes(item.id));
  return <>
    <button
      ref={trigger}
      type="button"
      className={navigation ? `panel-switcher-nav ${open || extraActive ? "active" : ""}` : "panel-switcher-trigger"}
      aria-label={tr(navigation ? "More" : "Switch panel")}
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={event => { event.currentTarget.focus({ preventScroll: true }); setOpen(true); }}
    >
      {navigation ? <><Icon name="more" /><span className="phone-label">{tr("More view")}</span></>
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
      </div>
      <button className="panel-switcher-commands" onClick={() => {
        setOpen(false);
        workbench.openPalette();
      }}><Icon name="search" /><span>{tr("Show All Commands")}</span><Icon name="chevR" /></button>
    </Dialog>, trigger.current?.closest(".workbench") ?? document.body)}
  </>;
}
