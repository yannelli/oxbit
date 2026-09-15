import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  Icon,
  IconButton,
  IconProvider,
  TooltipLayer,
  translate as tr,
} from "@oxbit/ui";
import type { WorkbenchController } from "./controller.js";
import { Boundary, ToolbarContributions } from "./index.js";
import { currentTheme, themeMode, themeVariables } from "./contributions.js";
import {
  dockSides,
  minimumPanelWidth,
  panelContainers,
  panelGroups,
  panelLocation,
  type DockSide,
  type DropEdge,
  type PanelGroup,
  type PanelNode,
  type PanelTarget,
} from "./panel-layout.js";

const mime = "application/x-oxbit-panel";
interface PanelContext {
  workbench: WorkbenchController;
  drag?: string;
  setDrag(id?: string): void;
  pointerTarget?: PanelTarget;
  setPointerTarget(target?: PanelTarget): void;
  dragCleanup: React.RefObject<(() => void) | undefined>;
  scope: string;
  targets: Map<string, HTMLElement>;
  containers: Map<string, HTMLElement>;
  parking: React.RefObject<HTMLDivElement | null>;
}
const Context = createContext<PanelContext>(null!);
const usePanels = () => useContext(Context);

export function PanelProvider(props: {
  workbench: WorkbenchController;
  children?: ReactNode;
  active?: boolean;
}) {
  const existing = useContext(Context);
  return existing?.workbench === props.workbench ? (
    <>{props.children}</>
  ) : (
    <PanelProviderContents {...props} />
  );
}
function PanelProviderContents({
  workbench,
  children,
  active = true,
}: {
  workbench: WorkbenchController;
  children?: ReactNode;
  active?: boolean;
}) {
  const state = useSyncExternalStore(workbench.subscribe, workbench.snapshot);
  const [drag, setDrag] = useState<string>();
  const [pointerTarget, setPointerTarget] = useState<PanelTarget>();
  const dragCleanup = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => dragCleanup.current?.(), []);
  const scope = useRef(crypto.randomUUID()).current;
  const targets = useRef(new Map<string, HTMLElement>()).current;
  const containers = useRef(new Map<string, HTMLElement>()).current;
  const visited = useRef(new Set<string>()).current;
  const parking = useRef<HTMLDivElement>(null);
  const contributions = workbench.kernel.contributions
    .list()
    .filter((c) => ["activityView", "panel"].includes(c.kind) && c.component);
  for (const { root } of panelContainers(state.panelLayout))
    for (const group of panelGroups(root)) visited.add(group.active);
  for (const item of contributions)
    if (visited.has(item.id) && !containers.has(item.id)) {
      const element = document.createElement("div");
      element.className = "panel-instance";
      element.dataset.panelInstance = item.id;
      containers.set(item.id, element);
    }
  useEffect(() => {
    workbench.panelWindows.start();
  }, [workbench]);
  useLayoutEffect(() => {
    for (const [id, element] of containers) {
      if (!contributions.some((c) => c.id === id)) {
        element.remove();
        containers.delete(id);
        continue;
      }
      const target = targets.get(id) ?? parking.current;
      if (target && element.parentElement !== target) {
        // Adopt the stable portal container; React component state and service subscriptions survive.
        const focused = element.ownerDocument
          .activeElement as HTMLElement | null;
        const restoreFocus = !!focused && element.contains(focused);
        target.append(element);
        element.dispatchEvent(
          new CustomEvent("oxbit-panel-moved", { bubbles: true }),
        );
        if (restoreFocus) focused.focus({ preventScroll: true });
      }
    }
  });
  const value = {
    workbench,
    drag,
    setDrag,
    pointerTarget,
    setPointerTarget,
    dragCleanup,
    scope,
    targets,
    containers,
    parking,
  };
  const waiting = state.panelLayout.floating.filter(
    (f) => !workbench.panelWindows.has(f.id),
  );
  return (
    <Context.Provider value={value}>
      <IconProvider
        kernel={workbench.kernel}
        variant={
          currentTheme(workbench.kernel).highContrast
            ? "highContrast"
            : themeMode(workbench.kernel)
        }
        values={Object.fromEntries(
          workbench.kernel.contributions
            .list("icon")
            .map((item) => [
              item.id,
              (item.data as { path?: string })?.path ?? "",
            ]),
        )}
      >
        {children}
        <div hidden ref={parking} />
        {active && waiting.length > 0 && (
          <div className="panel-restore-notice" role="status">
            <button
              className="button"
              onClick={workbench.panelWindows.restoreAll}
            >
              {tr("Restore floating panels")}
            </button>
            <button
              className="button"
              onClick={() =>
                waiting.forEach((f) =>
                  workbench.panelWindows.returnWindow(f.id),
                )
              }
            >
              {tr("Dock all panels")}
            </button>
          </div>
        )}
        {state.panelLayout.floating.map((floating) => {
          const child = workbench.panelWindows.windows.get(floating.id);
          const root = child?.document.getElementById("panel-root");
          return (
            root &&
            createPortal(
              <FloatingSurface id={floating.id} root={floating.root} />,
              root,
              floating.id,
            )
          );
        })}
        {contributions
          .filter((c) => visited.has(c.id))
          .map((item) => {
            const C = item.component!;
            return createPortal(
              <Boundary name={item.title}>
                <C
                  kernel={workbench.kernel}
                  workbench={workbench}
                  documents={workbench.documents}
                />
              </Boundary>,
              containers.get(item.id)!,
              item.id,
            );
          })}
      </IconProvider>
    </Context.Provider>
  );
}

function FloatingSurface({ id, root }: { id: string; root: PanelNode }) {
  const { workbench } = usePanels();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const doc = ref.current?.ownerDocument;
    if (doc)
      doc.title =
        workbench.state.projectName +
        " — " +
        panelGroups(root)
          .map(
            (g) =>
              workbench.kernel.contributions
                .list()
                .find((c) => c.id === g.active)?.title ?? g.active,
          )
          .join(", ");
  }, [workbench, root]);
  return (
    <div
      ref={ref}
      className="workbench floating-workbench"
      data-theme={themeMode(workbench.kernel)}
      data-theme-id={currentTheme(workbench.kernel).id}
      data-mode="desktop"
      data-density={
        workbench.kernel.configuration.get<string>("workbench.density") ??
        "compact"
      }
      data-high-contrast={
        currentTheme(workbench.kernel).highContrast ? "true" : undefined
      }
      style={themeVariables(workbench.kernel)}
      data-tooltip-root=""
    >
      <div className="floating-title">
        <span>{workbench.state.projectName}</span>
        <button
          className="button"
          onClick={() => workbench.panelWindows.returnWindow(id)}
        >
          {tr("Dock Back")}
        </button>
      </div>
      <PanelTree node={root} container={id} />
      <TooltipLayer rootRef={ref} />
    </div>
  );
}

function readDrag(event: React.DragEvent, context: PanelContext) {
  try {
    const data = JSON.parse(event.dataTransfer.getData(mime));
    return data.scope === context.scope &&
      typeof data.id === "string" &&
      panelLocation(context.workbench.state.panelLayout, data.id)
      ? (data.id as string)
      : undefined;
  } catch {
    return;
  }
}
/** Native file drops reserve the OS drag handler. Pointer capture keeps panel moves
 * independent of that handler, including moves to another related document. */
function startPointerDrag(
  event: React.PointerEvent<HTMLElement>,
  id: string,
  context: PanelContext,
) {
  context.dragCleanup.current?.();
  const tab = event.currentTarget,
    origin = tab.ownerDocument.defaultView!;
  const start = { x: event.clientX, y: event.clientY },
    pointerId = event.pointerId;
  let moving = false,
    destination: PanelTarget | undefined;
  tab.setPointerCapture(pointerId);
  const hit = (e: PointerEvent): PanelTarget | undefined => {
    const floats = [...context.workbench.panelWindows.windows.values()].filter(
      (w) => !w.closed,
    );
    // Related windows expose geometry in screen coordinates. The original
    // document's pointer coordinates stay exact throughout pointer capture.
    for (const win of [...floats.reverse(), window]) {
      const border = (win.outerWidth - win.innerWidth) / 2;
      const x = win === origin ? e.clientX : e.screenX - win.screenX - border;
      const y =
        win === origin
          ? e.clientY
          : e.screenY -
            win.screenY -
            (win.outerHeight - win.innerHeight - border);
      if (x < 0 || y < 0 || x >= win.innerWidth || y >= win.innerHeight)
        continue;
      const element = win.document.elementFromPoint(x, y);
      const group = element?.closest<HTMLElement>("[data-panel-group]");
      if (group) {
        const container = panelContainers(
          context.workbench.state.panelLayout,
        ).find((c) =>
          panelGroups(c.root).some((g) => g.id === group.dataset.panelGroup),
        );
        if (!container) continue;
        const rect = group.getBoundingClientRect(),
          rx = (x - rect.left) / rect.width,
          ry = (y - rect.top) / rect.height;
        const targetTab = element?.closest<HTMLElement>("[data-panel-tab]");
        return {
          container: container.id,
          group: group.dataset.panelGroup,
          index: targetTab ? Number(targetTab.dataset.panelTab) : undefined,
          edge: targetTab
            ? "center"
            : rx < 0.22
              ? "left"
              : rx > 0.78
                ? "right"
                : ry < 0.22
                  ? "top"
                  : ry > 0.78
                    ? "bottom"
                    : "center",
        };
      }
      const dock = element?.closest<HTMLElement>("[data-dock]");
      if (dock) return { container: dock.dataset.dock! };
    }
  };
  const move = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    if (!moving && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 5)
      return;
    e.preventDefault();
    if (!moving) {
      moving = true;
      context.setDrag(id);
    }
    destination = hit(e);
    context.setPointerTarget(destination);
  };
  const suppressClick = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };
  const cleanup = () => {
    origin.removeEventListener("pointermove", move);
    origin.removeEventListener("pointerup", up);
    origin.removeEventListener("pointercancel", cleanup);
    origin.removeEventListener("keydown", key, true);
    if (tab.hasPointerCapture(pointerId)) tab.releasePointerCapture(pointerId);
    if (moving) {
      origin.addEventListener("click", suppressClick, {
        capture: true,
        once: true,
      });
      setTimeout(
        () => origin.removeEventListener("click", suppressClick, true),
        0,
      );
    }
    context.setDrag(undefined);
    context.setPointerTarget(undefined);
    context.dragCleanup.current = undefined;
  };
  const up = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    if (moving && destination) context.workbench.movePanel(id, destination);
    cleanup();
  };
  const key = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cleanup();
    }
  };
  context.dragCleanup.current = cleanup;
  origin.addEventListener("pointermove", move);
  origin.addEventListener("pointerup", up);
  origin.addEventListener("pointercancel", cleanup);
  origin.addEventListener("keydown", key, true);
}
function dragProps(id: string, context: PanelContext) {
  return {
    draggable: !context.workbench.panelWindows.pointerDrag,
    onPointerDown(event: React.PointerEvent<HTMLElement>) {
      if (context.workbench.panelWindows.pointerDrag && event.button === 0)
        startPointerDrag(event, id, context);
    },
    onDragStart(event: React.DragEvent) {
      event.dataTransfer.setData(
        mime,
        JSON.stringify({ scope: context.scope, id }),
      );
      event.dataTransfer.effectAllowed = "move";
      context.setDrag(id);
    },
    onDragEnd() {
      context.setDrag(undefined);
    },
  };
}
function PanelSlot({ id }: { id: string }) {
  const { targets, containers, parking } = usePanels();
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (ref.current) {
      targets.set(id, ref.current);
      const container = containers.get(id);
      if (container) ref.current.append(container);
    }
    return () => {
      targets.delete(id);
      const container = containers.get(id);
      // Do not strand content in a removed tree/closed window between layout effects.
      if (container && parking.current) parking.current.append(container);
    };
  }, [id, targets, containers, parking]);
  return (
    <div
      ref={ref}
      className="panel-slot panel-content sidebar-content"
      role="tabpanel"
      aria-label={id}
    />
  );
}

function Sash({
  label,
  vertical,
  value,
  change,
}: {
  label: string;
  vertical: boolean;
  value: number;
  change(delta: number, rect: DOMRect): void;
}) {
  const cleanup = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => cleanup.current?.(), []);
  return (
    <div
      className={`dock-sash ${vertical ? "vertical" : "horizontal"}`}
      role="separator"
      tabIndex={0}
      aria-label={tr(label)}
      aria-orientation={vertical ? "vertical" : "horizontal"}
      aria-valuenow={Math.round(value)}
      onKeyDown={(event) => {
        const keys = vertical
          ? ["ArrowLeft", "ArrowRight"]
          : ["ArrowUp", "ArrowDown"];
        if (!keys.includes(event.key)) return;
        event.preventDefault();
        change(
          event.key === keys[0] ? -10 : 10,
          event.currentTarget.parentElement!.getBoundingClientRect(),
        );
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        cleanup.current?.();
        const win = event.currentTarget.ownerDocument.defaultView!;
        const rect = event.currentTarget.parentElement!.getBoundingClientRect();
        const start = vertical ? event.clientX : event.clientY;
        const move = (e: PointerEvent) =>
          change((vertical ? e.clientX : e.clientY) - start, rect);
        const up = () => {
          win.removeEventListener("pointermove", move);
          win.removeEventListener("pointerup", up);
          win.removeEventListener("pointercancel", up);
        };
        cleanup.current = up;
        win.addEventListener("pointermove", move);
        win.addEventListener("pointerup", up, { once: true });
        win.addEventListener("pointercancel", up, { once: true });
      }}
    />
  );
}

export function PanelDock({
  side,
  mode,
}: {
  side: DockSide;
  mode: "desktop" | "tablet" | "phone";
}) {
  const context = usePanels(),
    { workbench, drag } = context;
  const state = workbench.state,
    dock = state.panelLayout.docks[side];
  const visible =
    dock.visible &&
    !state.focus &&
    (mode === "desktop" ||
      (state.panelOverlay && side === state.panelLayout.activeDock));
  if (!visible && !drag) return null;
  const bottom = side === "bottom";
  const style = visible
    ? bottom
      ? {
          height:
            state.maxPanel && mode === "desktop"
              ? "100%"
              : mode === "desktop"
                ? dock.size
                : "50%",
        }
      : {
          width:
            mode === "phone" ? "100%" : mode === "tablet" ? 320 : dock.size,
        }
    : {};
  return (
    <>
      {visible && mode !== "desktop" && (
        <button
          className={bottom ? "panel-scrim" : "sidebar-scrim"}
          aria-label={tr(bottom ? "Close panel" : "Close sidebar")}
          onClick={() => workbench.toggleDock(side)}
        />
      )}
      <section
        aria-label={tr(
          side === "left"
            ? "Left panels"
            : side === "right"
              ? "Right panels"
              : "Panel",
        )}
        data-dock={side}
        className={`panel-dock dock-${side} ${bottom ? "bottom-panel" : "sidebar"} ${!visible ? "dock-drop-rail" : ""} ${state.maxPanel && bottom ? "maximized" : ""}`}
        style={style}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes(mime)) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
          }
        }}
        onDrop={(event) => {
          const id = readDrag(event, context);
          if (id) {
            event.preventDefault();
            workbench.movePanel(id, { container: side });
            context.setDrag(undefined);
          }
        }}
      >
        {visible && mode === "desktop" && (
          <Sash
            label={
              bottom
                ? "Resize panel"
                : side === "left"
                  ? "Resize left panels"
                  : "Resize right panels"
            }
            vertical={!bottom}
            value={dock.size}
            change={(delta) =>
              workbench.resizeDock(
                side,
                dock.size + delta * (side === "left" ? 1 : -1),
              )
            }
          />
        )}
        {visible && dock.root ? (
          <PanelTree node={dock.root} container={side} />
        ) : (
          <div className="dock-empty">{tr("Drop a panel here")}</div>
        )}
      </section>
    </>
  );
}

function PanelTree({
  node,
  container,
}: {
  node: PanelNode;
  container: string;
}) {
  const { workbench } = usePanels();
  if (node.kind === "group")
    return <PanelTabs group={node} container={container} />;
  const vertical = node.direction === "row";
  return (
    <div
      className="dock-split"
      data-split={node.id}
      style={{
        flexDirection: node.direction,
        minWidth: minimumPanelWidth(node),
      }}
    >
      <div className="dock-split-child" style={{ flex: `${node.ratio} 1 0` }}>
        <PanelTree node={node.children[0]} container={container} />
      </div>
      <Sash
        label={vertical ? "Resize panel columns" : "Resize panel rows"}
        vertical={vertical}
        value={node.ratio * 100}
        change={(delta, rect) =>
          workbench.resizePanelSplit(
            node.id,
            node.ratio + delta / (vertical ? rect.width : rect.height),
          )
        }
      />
      <div
        className="dock-split-child"
        style={{ flex: `${1 - node.ratio} 1 0` }}
      >
        <PanelTree node={node.children[1]} container={container} />
      </div>
    </div>
  );
}

function PanelMenu({
  label,
  sections,
  onSelect,
}: {
  label: string;
  sections: { value: string; label: string }[][];
  onSelect(value: string): void;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const items = () =>
    Array.from(
      popup.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ??
        [],
    );
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
    const width = Math.min(280, win.innerWidth - 16);
    const below = win.innerHeight - rect.bottom - 8;
    const above = rect.top - 8;
    const upward = below < 240 && above > below;
    Object.assign(element.style, {
      width: `${width}px`,
      left: `${Math.max(8, Math.min(rect.right - width, win.innerWidth - width - 8))}px`,
      top: upward ? "auto" : `${rect.bottom + 4}px`,
      bottom: upward ? `${win.innerHeight - rect.top + 4}px` : "auto",
      maxHeight: `${Math.max(60, upward ? above : below)}px`,
    });
    element.showPopover();
    const buttons = items();
    (last ? buttons.at(-1) : buttons[0])?.focus();
  };
  useEffect(() => {
    const win = trigger.current?.ownerDocument.defaultView;
    const element = popup.current;
    const close = () => element?.hidePopover();
    win?.addEventListener("resize", close);
    win?.addEventListener("blur", close);
    return () => {
      close();
      win?.removeEventListener("resize", close);
      win?.removeEventListener("blur", close);
    };
  }, [label]);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="icon-button"
        aria-label={label}
        data-tooltip={tr("Panel actions")}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        popoverTarget={id}
        onClick={(event) => {
          event.preventDefault();
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
        <Icon name="more" />
      </button>
      <div
        ref={popup}
        id={id}
        className="command-menu panel-menu"
        popover="auto"
        role="menu"
        aria-label={label}
        onToggle={(event) => setOpen(event.newState === "open")}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
            event.preventDefault();
            event.stopPropagation();
            const buttons = items();
            const index = buttons.indexOf(
              event.currentTarget.ownerDocument
                .activeElement as HTMLButtonElement,
            );
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? buttons.length - 1
                  : (index +
                      (event.key === "ArrowDown" ? 1 : buttons.length - 1)) %
                    buttons.length;
            buttons[next]?.focus();
          } else if (event.key === "Escape" || event.key === "Tab") {
            if (event.key === "Escape") event.preventDefault();
            event.stopPropagation();
            dismiss(true);
          }
        }}
      >
        {sections
          .filter((section) => section.length)
          .flatMap((section, index) => [
            ...(index
              ? [<hr key={`separator-${index}`} role="separator" />]
              : []),
            ...section.map((item) => (
              <button
                key={item.value}
                type="button"
                role="menuitem"
                onClick={() => {
                  dismiss(true);
                  onSelect(item.value);
                }}
              >
                {item.label}
              </button>
            )),
          ])}
      </div>
    </>
  );
}

function PanelTabs({
  group,
  container,
}: {
  group: PanelGroup;
  container: string;
}) {
  const context = usePanels(),
    { workbench, drag } = context;
  const [edge, setEdge] = useState<DropEdge>();
  const groupRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const selected = groupRef.current?.querySelector<HTMLElement>(
      '[role="tab"][aria-selected="true"]',
    );
    const tabs = selected?.parentElement;
    if (!selected || !tabs) return;
    const tabRect = selected.getBoundingClientRect();
    const stripRect = tabs.getBoundingClientRect();
    if (tabRect.right > stripRect.right)
      tabs.scrollLeft += tabRect.right - stripRect.right;
    else if (tabRect.left < stripRect.left)
      tabs.scrollLeft -= stripRect.left - tabRect.left;
  }, [group.active, container]);
  const contributions = workbench.kernel.contributions.list();
  const active = contributions.find((c) => c.id === group.active);
  const isDock = dockSides.includes(container as DockSide);
  const previewEdge =
    context.pointerTarget?.group === group.id
      ? context.pointerTarget.edge
      : edge;
  const target = (edge: DropEdge): PanelTarget => ({
    container,
    group: group.id,
    edge,
  });
  const drop = (event: React.DragEvent, destination: PanelTarget) => {
    const id = readDrag(event, context);
    if (!id) return;
    event.preventDefault();
    event.stopPropagation();
    workbench.movePanel(id, destination);
    setEdge(undefined);
    context.setDrag(undefined);
  };
  const action = (value: string) => {
    if (value.startsWith("group:")) {
      const groupId = value.slice(6);
      const destination = panelContainers(workbench.state.panelLayout).find(
        (c) => panelGroups(c.root).some((g) => g.id === groupId),
      );
      if (destination)
        workbench.movePanel(group.active, {
          container: destination.id,
          group: groupId,
        });
    } else if (value === "float") void workbench.detachPanel(group.active);
    else if (value === "dock") workbench.redockPanel(group.active);
    else if (value.startsWith("split:"))
      workbench.movePanel(group.active, target(value.slice(6) as DropEdge));
    else workbench.movePanel(group.active, { container: value });
  };
  // Native listeners follow the DOM across React portals; synthetic bubbling follows
  // the original component tree and would miss drops over adopted panel contents.
  useEffect(() => {
    const element = groupRef.current!;
    const over = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes(mime)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "move";
      const rect = element.getBoundingClientRect(),
        x = (event.clientX - rect.left) / rect.width,
        y = (event.clientY - rect.top) / rect.height;
      setEdge(
        (event.target as HTMLElement).closest("[data-panel-tab]")
          ? "center"
          : x < 0.22
            ? "left"
            : x > 0.78
              ? "right"
              : y < 0.22
                ? "top"
                : y > 0.78
                  ? "bottom"
                  : "center",
      );
    };
    const dropped = (event: DragEvent) => {
      const tab = (event.target as HTMLElement).closest<HTMLElement>(
        "[data-panel-tab]",
      );
      drop(
        event as unknown as React.DragEvent,
        tab
          ? { ...target("center"), index: Number(tab.dataset.panelTab) }
          : target(edge ?? "center"),
      );
    };
    const leave = (event: DragEvent) => {
      if (!element.contains(event.relatedTarget as Node | null))
        setEdge(undefined);
    };
    element.addEventListener("dragover", over, true);
    element.addEventListener("drop", dropped, true);
    element.addEventListener("dragleave", leave);
    return () => {
      element.removeEventListener("dragover", over, true);
      element.removeEventListener("drop", dropped, true);
      element.removeEventListener("dragleave", leave);
    };
  });
  return (
    <div ref={groupRef} className="dock-group" data-panel-group={group.id}>
      <div className="panel-header sidebar-heading">
        <div
          className="panel-tabs"
          role="tablist"
          aria-label={tr("Panel views")}
        >
          {group.panels.map((id, index) => (
            <button
              key={id}
              data-panel-tab={index}
              role="tab"
              aria-selected={id === group.active}
              className={id === group.active ? "selected" : ""}
              tabIndex={id === group.active ? 0 : -1}
              {...dragProps(id, context)}
              onClick={() => workbench.openPanel(id)}
              onDragOver={(event) => {
                if (event.dataTransfer.types.includes(mime)) {
                  event.preventDefault();
                  event.stopPropagation();
                  setEdge("center");
                }
              }}
              onDrop={(event) => drop(event, { ...target("center"), index })}
              onKeyDown={(event) => {
                if (
                  !["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                    event.key,
                  )
                )
                  return;
                event.preventDefault();
                const next =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? group.panels.length - 1
                      : (index +
                          (event.key === "ArrowRight" ? 1 : -1) +
                          group.panels.length) %
                        group.panels.length;
                workbench.openPanel(group.panels[next]);
                (
                  event.currentTarget.parentElement!.children[
                    next
                  ] as HTMLElement
                ).focus();
              }}
            >
              {tr(contributions.find((c) => c.id === id)?.title ?? id)}
            </button>
          ))}
        </div>
        <div className="panel-actions">
          <ToolbarContributions
            workbench={workbench}
            location={
              (active?.kind === "activityView" ? "sidebar:" : "panel:") +
              group.active
            }
          />
          {group.active === "explorer" && (
            <>
              <IconButton
                icon="newFile"
                label={tr("New File")}
                onClick={() => void workbench.run("file.new")}
              />
              <IconButton
                icon="newFolder"
                label={tr("New Folder")}
                onClick={() => void workbench.run("file.newFolder")}
              />
              <IconButton
                icon="collapse"
                label={tr("Collapse folders")}
                onClick={() => workbench.set({ expanded: [] })}
              />
            </>
          )}
          <PanelMenu
            label={
              tr("Panel actions") + ": " + tr(active?.title ?? group.active)
            }
            onSelect={action}
            sections={[
              [
                { value: "left", label: tr("Move to Left") },
                { value: "right", label: tr("Move to Right") },
                { value: "bottom", label: tr("Move to Bottom") },
              ],
              group.panels.length > 1
                ? [
                    { value: "split:top", label: tr("Split Above") },
                    { value: "split:bottom", label: tr("Split Below") },
                    { value: "split:left", label: tr("Split Left") },
                    { value: "split:right", label: tr("Split Right") },
                  ]
                : [],
              panelContainers(workbench.state.panelLayout).flatMap((c) =>
                panelGroups(c.root)
                  .filter((g) => g.id !== group.id)
                  .map((g, index) => ({
                    value: "group:" + g.id,
                    label:
                      tr("Move to group") +
                      ": " +
                      tr(
                        dockSides.includes(c.id as DockSide)
                          ? c.id === "left"
                            ? "Left"
                            : c.id === "right"
                              ? "Right"
                              : "Bottom"
                          : "Floating window",
                      ) +
                      " " +
                      (index + 1) +
                      ": " +
                      tr(
                        contributions.find((item) => item.id === g.active)
                          ?.title ?? g.active,
                      ),
                  })),
              ),
              [
                ...(workbench.panelWindows.canDetach ? [{ value: "float", label: tr("Pop Out Panel") }] : []),
                ...(!isDock ? [{ value: "dock", label: tr("Dock Back") }] : []),
              ],
            ]}
          />
          {workbench.panelWindows.canDetach && (
            <IconButton
              icon="goto"
              label={tr("Pop Out Panel")}
              onClick={() => void workbench.detachPanel(group.active)}
            />
          )}
          {container === "bottom" && (
            <IconButton
              icon={workbench.state.maxPanel ? "minimize" : "maximize"}
              label={tr("Maximize panel")}
              onClick={() =>
                workbench.set({ maxPanel: !workbench.state.maxPanel })
              }
            />
          )}
          <IconButton
            icon="x"
            label={tr(
              isDock
                ? container === "bottom"
                  ? "Close panel"
                  : "Close sidebar"
                : "Dock Back",
            )}
            onClick={() =>
              isDock
                ? workbench.toggleDock(container as DockSide)
                : workbench.redockPanel(group.active)
            }
          />
        </div>
      </div>
      <PanelSlot id={group.active} />
      {drag && previewEdge && (
        <div
          className={`panel-drop-preview drop-${previewEdge}`}
          aria-hidden="true"
        >
          {tr(previewEdge === "center" ? "Add to group" : "Split here")}
        </div>
      )}
    </div>
  );
}
