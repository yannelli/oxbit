import type {
  DockSide,
  PanelGroup,
  PanelNode,
  PanelBounds,
  PanelTarget,
  PanelLayout,
} from "@oxbit/sdk";
export type {
  DockSide,
  DropEdge,
  PanelGroup,
  PanelSplit,
  PanelNode,
  PanelDock,
  PanelBounds,
  FloatingPanel,
  PanelTarget,
  PanelLayout,
} from "@oxbit/sdk";
export const dockSides: DockSide[] = ["left", "right", "bottom"];
const uid = () => "dock-" + crypto.randomUUID();
export const panelGroup = (
  panels: string[],
  active = panels[0],
): PanelGroup => ({ kind: "group", id: uid(), panels, active });
export const emptyPanelLayout = (): PanelLayout => ({
  version: 1,
  docks: {
    left: { visible: true, size: 260 },
    right: { visible: false, size: 300 },
    bottom: { visible: false, size: 220 },
  },
  floating: [],
  returns: {},
  activeDock: "left",
});
export function panelGroups(node?: PanelNode): PanelGroup[] {
  return !node
    ? []
    : node.kind === "group"
      ? [node]
      : node.children.flatMap(panelGroups);
}
export function panelContainers(layout: PanelLayout) {
  return [
    ...dockSides.map((id) => ({ id, root: layout.docks[id].root })),
    ...layout.floating,
  ];
}
export function panelLocation(
  layout: PanelLayout,
  panel: string,
): PanelTarget | undefined {
  for (const { id, root } of panelContainers(layout)) {
    const group = panelGroups(root).find((g) => g.panels.includes(panel));
    if (group)
      return {
        container: id,
        group: group.id,
        index: group.panels.indexOf(panel),
      };
  }
}
function mapNode(
  node: PanelNode | undefined,
  fn: (group: PanelGroup) => PanelNode | undefined,
): PanelNode | undefined {
  if (!node) return;
  if (node.kind === "group") return fn(node);
  const a = mapNode(node.children[0], fn),
    b = mapNode(node.children[1], fn);
  return a && b ? { ...node, children: [a, b] } : a || b;
}
function setRoot(layout: PanelLayout, container: string, root?: PanelNode) {
  if (dockSides.includes(container as DockSide)) {
    const dock = layout.docks[container as DockSide];
    if (dock.root && !root) dock.visible = false;
    dock.root = root;
  } else
    layout.floating = layout.floating.flatMap((f) =>
      f.id !== container ? [f] : root ? [{ ...f, root }] : [],
    );
}
function removePanel(layout: PanelLayout, panel: string) {
  for (const { id, root } of panelContainers(layout))
    setRoot(
      layout,
      id,
      mapNode(root, (group) => {
        const panels = group.panels.filter((p) => p !== panel);
        return panels.length
          ? {
              ...group,
              panels,
              active: panels.includes(group.active) ? group.active : panels[0],
            }
          : undefined;
      }),
    );
}
/** Returns the original layout for invalid/self-split drops. Never removes a panel on failure. */
export function movePanel(
  layout: PanelLayout,
  panel: string,
  target: PanelTarget,
): PanelLayout {
  if (!panelLocation(layout, panel)) return layout;
  const container = panelContainers(layout).find(
    (c) => c.id === target.container,
  );
  if (!container) return layout;
  const before =
    panelGroups(container.root).find((g) => g.id === target.group) ??
    (!target.group ? panelGroups(container.root)[0] : undefined);
  if (target.group && !before) return layout;
  const edge = target.edge ?? "center";
  if (
    before?.panels.length === 1 &&
    before.panels[0] === panel &&
    edge !== "center"
  )
    return layout;
  const next = structuredClone(layout);
  // A sole-panel floating group may vanish while moving within its own container.
  const float = next.floating.find((f) => f.id === target.container);
  removePanel(next, panel);
  if (float && !next.floating.some((f) => f.id === float.id))
    next.floating.push(float);
  const root = panelContainers(next).find(
    (c) => c.id === target.container,
  )?.root;
  let destination = panelGroups(root).find((g) => g.id === before?.id);
  if (!destination && root && before?.panels.includes(panel))
    destination = panelGroups(root)[0];
  if (!root || !destination)
    setRoot(next, target.container, panelGroup([panel]));
  else
    setRoot(
      next,
      target.container,
      mapNode(root, (group) => {
        if (group.id !== destination.id) return group;
        if (edge === "center") {
          const panels = group.panels.filter((p) => p !== panel);
          panels.splice(
            Math.max(0, Math.min(target.index ?? panels.length, panels.length)),
            0,
            panel,
          );
          return { ...group, panels, active: panel };
        }
        const inserted = panelGroup([panel]);
        return {
          kind: "split",
          id: uid(),
          direction: edge === "left" || edge === "right" ? "row" : "column",
          ratio: 0.5,
          children:
            edge === "left" || edge === "top"
              ? [inserted, group]
              : [group, inserted],
        };
      }),
    );
  if (dockSides.includes(target.container as DockSide)) {
    next.activeDock = target.container as DockSide;
    next.docks[next.activeDock].visible = true;
    if (next.activeDock !== "bottom")
      next.docks[next.activeDock].size = Math.max(
        next.docks[next.activeDock].size,
        Math.min(1000, minimumPanelWidth(next.docks[next.activeDock].root)),
      );
    delete next.returns[panel];
  } else if (!next.returns[panel]) {
    const source = panelLocation(layout, panel);
    next.returns[panel] =
      source && dockSides.includes(source.container as DockSide)
        ? source
        : { container: "left" };
  }
  return next;
}
export function minimumPanelWidth(node?: PanelNode): number {
  if (!node || node.kind === "group") return 200;
  const sizes = node.children.map(minimumPanelWidth);
  return node.direction === "row"
    ? sizes[0] + sizes[1] + 4
    : Math.max(...sizes);
}
export function revealPanel(layout: PanelLayout, panel: string): PanelLayout {
  const location = panelLocation(layout, panel);
  if (!location) return layout;
  const next = structuredClone(layout);
  const root = panelContainers(next).find(
    (c) => c.id === location.container,
  )?.root;
  setRoot(
    next,
    location.container,
    mapNode(root, (group) =>
      group.id === location.group ? { ...group, active: panel } : group,
    ),
  );
  if (dockSides.includes(location.container as DockSide)) {
    next.activeDock = location.container as DockSide;
    next.docks[next.activeDock].visible = true;
  }
  return next;
}
export function detachPanel(
  layout: PanelLayout,
  panel: string,
  id: string,
  bounds: PanelBounds,
): PanelLayout {
  const source = panelLocation(layout, panel);
  if (!source) return layout;
  const next = structuredClone(layout);
  const original = next.returns[panel] ?? source;
  removePanel(next, panel);
  next.floating.push({ id, root: panelGroup([panel]), bounds });
  next.returns[panel] = dockSides.includes(original.container as DockSide)
    ? original
    : { container: "left" };
  return next;
}
export function redockPanel(layout: PanelLayout, panel: string): PanelLayout {
  const saved = layout.returns[panel] ?? { container: "left" };
  const root = layout.docks[saved.container as DockSide]?.root;
  const target = {
    ...saved,
    group: panelGroups(root).some((g) => g.id === saved.group)
      ? saved.group
      : undefined,
  };
  return movePanel(layout, panel, target);
}
export function resizePanelSplit(
  layout: PanelLayout,
  id: string,
  ratio: number,
): PanelLayout {
  if (!Number.isFinite(ratio)) return layout;
  const next = structuredClone(layout);
  function resize(node?: PanelNode): void {
    if (node?.kind !== "split") return;
    if (node.id === id) node.ratio = Math.max(0.1, Math.min(0.9, ratio));
    node.children.forEach(resize);
  }
  panelContainers(next).forEach((c) => resize(c.root));
  return next;
}
export function reconcilePanels(
  layout: PanelLayout,
  panels: { id: string; kind: string }[],
  primary: DockSide,
): PanelLayout {
  const next = structuredClone(layout),
    available = new Set(panels.map((p) => p.id)),
    seen = new Set<string>();
  for (const { id, root } of panelContainers(next))
    setRoot(
      next,
      id,
      mapNode(root, (group) => {
        const ids = group.panels.filter(
          (p) => available.has(p) && !seen.has(p) && !!seen.add(p),
        );
        return ids.length
          ? {
              ...group,
              panels: ids,
              active: ids.includes(group.active) ? group.active : ids[0],
            }
          : undefined;
      }),
    );
  for (const panel of panels) {
    if (seen.has(panel.id)) continue;
    const dock = next.docks[panel.kind === "activityView" ? primary : "bottom"];
    const group = panelGroups(dock.root)[0];
    if (group) group.panels.push(panel.id);
    else dock.root = panelGroup([panel.id]);
  }
  for (const id of Object.keys(next.returns))
    if (!available.has(id)) delete next.returns[id];
  return JSON.stringify(next) === JSON.stringify(layout) ? layout : next;
}
/** Bound untrusted persisted trees before walking them. Invalid data uses legacy migration. */
export function validPanelLayout(value: unknown): value is PanelLayout {
  if (!value || typeof value !== "object") return false;
  const layout = value as PanelLayout;
  const ids = new Set<string>();
  let count = 0;
  const node = (n: PanelNode | undefined, depth = 0): boolean => {
    if (!n) return true;
    if (
      ++count > 500 ||
      depth > 20 ||
      typeof n.id !== "string" ||
      ids.has(n.id)
    )
      return false;
    ids.add(n.id);
    return n.kind === "group"
      ? Array.isArray(n.panels) &&
          n.panels.every((p) => typeof p === "string") &&
          typeof n.active === "string"
      : n.kind === "split" &&
          ["row", "column"].includes(n.direction) &&
          Number.isFinite(n.ratio) &&
          n.ratio >= 0.1 &&
          n.ratio <= 0.9 &&
          Array.isArray(n.children) &&
          n.children.length === 2 &&
          n.children.every((c) => !!c && node(c, depth + 1));
  };
  const windowIds = new Set<string>();
  return (
    layout.version === 1 &&
    !!layout.docks &&
    dockSides.includes(layout.activeDock) &&
    dockSides.every((s) => {
      const dock = layout.docks[s];
      return (
        dock &&
        typeof dock.visible === "boolean" &&
        Number.isFinite(dock.size) &&
        dock.size >= 100 &&
        dock.size <= 2000 &&
        node(dock.root)
      );
    }) &&
    Array.isArray(layout.floating) &&
    layout.floating.every(
      (f) =>
        !!f &&
        typeof f.id === "string" &&
        !windowIds.has(f.id) &&
        !!windowIds.add(f.id) &&
        !dockSides.includes(f.id as DockSide) &&
        !!f.root &&
        node(f.root) &&
        !!f.bounds &&
        [f.bounds.x, f.bounds.y, f.bounds.width, f.bounds.height].every(
          Number.isFinite,
        ),
    ) &&
    !!layout.returns &&
    typeof layout.returns === "object" &&
    Object.values(layout.returns).every(
      (t) =>
        t &&
        dockSides.includes(t.container as DockSide) &&
        (t.group === undefined || typeof t.group === "string") &&
        (t.index === undefined || Number.isFinite(t.index)),
    )
  );
}
