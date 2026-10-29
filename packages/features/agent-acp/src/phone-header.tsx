import type { DockSide, DropEdge, Kernel, WorkbenchService } from "@oxbit/sdk";
import { translate as tr } from "@oxbit/ui";
import { ToolbarContributions, panelContainers, panelGroups, panelLocation, type WorkbenchController } from "@oxbit/workbench";
import { AGENT_VIEW } from "./attention.js";
import type { MenuItem } from "./overflow-menu.js";

const DOCKS: [DockSide, string, string][] = [
  ["left", "Move to Left", "layoutSide"],
  ["right", "Move to Right", "layoutSideRight"],
  ["bottom", "Move to Bottom", "layoutPanel"],
];
const SPLITS: [DropEdge, string, string][] = [
  ["top", "Split Above", "splitD"],
  ["bottom", "Split Below", "splitD"],
  ["left", "Split Left", "splitR"],
  ["right", "Split Right", "splitR"],
];

/** The panel header menu's move and split actions for the agent view. */
export function panelMenuItems(workbench: WorkbenchService, kernel: Kernel): MenuItem[] {
  const layout = workbench.getPanelLayout?.();
  if (!layout || !workbench.movePanel) return [];
  const move = (target: Parameters<NonNullable<WorkbenchService["movePanel"]>>[1]) =>
    workbench.movePanel?.(AGENT_VIEW, target);
  const location = panelLocation(layout, AGENT_VIEW);
  const containers = panelContainers(layout);
  const group = containers.flatMap((container) => panelGroups(container.root)).find((item) => item.id === location?.group);
  const title = (id: string) => tr(kernel.contributions.list().find((item) => item.id === id)?.title ?? id);
  return [
    ...DOCKS.filter(([side]) => side !== location?.container).map(([side, label, icon]) => ({
      id: `move:${side}`, label, icon, run: () => move({ container: side }),
    })),
    ...(location && group && group.panels.length > 1
      ? SPLITS.map(([edge, label, icon]) => ({
          id: `split:${edge}`, label, icon,
          run: () => move({ container: location.container, group: location.group, edge }),
        }))
      : []),
    ...containers.flatMap((container) =>
      panelGroups(container.root)
        .filter((item) => item.id !== location?.group)
        .map((item) => ({
          id: `group:${item.id}`,
          label: `${tr("Move to group")}: ${title(item.active)}`,
          icon: "goto",
          run: () => move({ container: container.id, group: item.id }),
        })),
    ),
  ];
}

/** Toolbar contributions for the agent view's panel header. */
export function PhoneToolbar({ workbench }: { workbench: WorkbenchService }) {
  if (!("kernel" in workbench)) return null;
  return <ToolbarContributions workbench={workbench as unknown as WorkbenchController} location={`sidebar:${AGENT_VIEW}`} />;
}
