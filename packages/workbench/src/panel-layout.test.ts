import { describe, expect, it } from "vitest";
import { createKernel } from "@oxbit/core";
import { BrowserFileSystem, MemoryPersistence } from "@oxbit/host-browser";
import { DocumentService } from "@oxbit/documents";
import { WorkbenchController } from "./controller.js";
import {
  detachPanel,
  emptyPanelLayout,
  movePanel,
  panelContainers,
  panelGroups,
  panelLocation,
  reconcilePanels,
  redockPanel,
  revealPanel,
  resizePanelSplit,
  validPanelLayout,
} from "./panel-layout.js";

const surfaces = [
  { id: "explorer", kind: "activityView" },
  { id: "search", kind: "activityView" },
  { id: "git", kind: "activityView" },
  { id: "terminal", kind: "panel" },
  { id: "output", kind: "panel" },
];
const layout = () => reconcilePanels(emptyPanelLayout(), surfaces, "left");
const all = (value: ReturnType<typeof layout>) =>
  panelContainers(value).flatMap((c) =>
    panelGroups(c.root).flatMap((g) => g.panels),
  );

describe("panel docking", () => {
  it("shows both side docks while retaining the bottom panel and unique homes", () => {
    let value = movePanel(layout(), "git", { container: "right" });
    value = revealPanel(value, "terminal");
    expect(value.docks.left.visible).toBe(true);
    expect(value.docks.right.visible).toBe(true);
    expect(value.docks.bottom.visible).toBe(true);
    expect(panelLocation(value, "git")?.container).toBe("right");
    expect(all(value).sort()).toEqual(surfaces.map((s) => s.id).sort());
  });
  it("supports nested splits in both directions and collapses empty branches", () => {
    let value = layout();
    value = movePanel(value, "search", {
      ...panelLocation(value, "explorer")!,
      edge: "bottom",
    });
    value = movePanel(value, "git", {
      ...panelLocation(value, "search")!,
      edge: "right",
    });
    expect(value.docks.left.root).toMatchObject({
      kind: "split",
      direction: "column",
      children: [{ kind: "group" }, { kind: "split", direction: "row" }],
    });
    value = movePanel(value, "git", { container: "right" });
    value = movePanel(value, "search", { container: "right" });
    expect(value.docks.left.root).toMatchObject({
      kind: "group",
      panels: ["explorer"],
    });
    expect(all(value).length).toBe(new Set(all(value)).size);
  });
  it("reorders tabs without duplicating and refuses stale/self-split targets", () => {
    const original = layout();
    const value = movePanel(original, "git", {
      ...panelLocation(original, "explorer")!,
      index: 0,
    });
    expect(panelGroups(value.docks.left.root)[0].panels).toEqual([
      "git",
      "explorer",
      "search",
    ]);
    expect(movePanel(value, "git", { container: "right", group: "gone" })).toBe(
      value,
    );
    const split = movePanel(value, "git", { container: "right" });
    expect(
      movePanel(split, "git", {
        ...panelLocation(split, "git")!,
        edge: "left",
      }),
    ).toBe(split);
    expect(all(original)).toContain("git");
  });
  it("detaches and returns a panel even after the original group disappears", () => {
    let value = movePanel(layout(), "terminal", { container: "right" });
    value = detachPanel(value, "terminal", "floating-1", {
      x: 20,
      y: 20,
      width: 500,
      height: 400,
    });
    expect(value.docks.right.root).toBeUndefined();
    expect(value.returns.terminal.container).toBe("right");
    value = redockPanel(value, "terminal");
    expect(value.floating).toEqual([]);
    expect(panelLocation(value, "terminal")?.container).toBe("right");
    expect(value.returns.terminal).toBeUndefined();
  });
  it("preserves a float's origin when detached again", () => {
    let value = detachPanel(layout(), "terminal", "floating-1", {
      x: 0,
      y: 0,
      width: 500,
      height: 400,
    });
    value = detachPanel(value, "terminal", "floating-2", {
      x: 0,
      y: 0,
      width: 500,
      height: 400,
    });
    expect(value.floating).toHaveLength(1);
    value = redockPanel(value, "terminal");
    expect(panelLocation(value, "terminal")?.container).toBe("bottom");
  });
  it("prunes removed contributions and preserves existing split sizes and locations", () => {
    let value = movePanel(layout(), "git", {
      ...panelLocation(layout(), "explorer"),
      container: "left",
      group: undefined,
      edge: "bottom",
    });
    value = resizePanelSplit(value, value.docks.left.root!.id, 0.7);
    const reconciled = reconcilePanels(
      value,
      surfaces.filter((s) => s.id !== "search"),
      "left",
    );
    expect(reconciled.docks.left.root).toMatchObject({ ratio: 0.7 });
    expect(all(reconciled)).not.toContain("search");
    expect(
      reconcilePanels(
        reconciled,
        surfaces.filter((s) => s.id !== "search"),
        "left",
      ),
    ).toBe(reconciled);
  });
  it("rejects malformed persisted trees", () => {
    expect(validPanelLayout(layout())).toBe(true);
    expect(validPanelLayout({ ...layout(), floating: [null] })).toBe(false);
    const value = layout();
    value.docks.left.root = {
      kind: "split",
      id: "cycle",
      direction: "row",
      ratio: 0.5,
      children: [] as any,
    };
    (value.docks.left.root as any).children = [
      value.docks.left.root,
      value.docks.bottom.root,
    ];
    expect(validPanelLayout(value)).toBe(false);
    expect(
      validPanelLayout({
        ...layout(),
        returns: { bad: { container: "unknown" } },
      }),
    ).toBe(false);
  });
  it("migrates the saved right sidebar and bottom panel without changing editor groups", async () => {
    const kernel = createKernel();
    const persistence = new MemoryPersistence();
    const filesystem = new BrowserFileSystem(persistence);
    const documents = new DocumentService(filesystem, persistence, kernel);
    const workbench = new WorkbenchController(
      kernel,
      documents,
      filesystem,
      persistence,
    );
    try {
      kernel.configuration.register({
        id: "workbench.sidebarLocation",
        title: "Sidebar Location",
        type: "string",
        default: "left",
      });
      kernel.configuration.set("workbench.sidebarLocation", "right");
      for (const surface of surfaces)
        kernel.contributions.register({
          ...surface,
          kind: surface.kind as "panel" | "activityView",
          title: surface.id,
          component: () => null,
        });
      await persistence.set(`layout:${filesystem.id}`, {
        groups: [{ id: "editor-1", tabs: [] }],
        activeGroup: "editor-1",
        sidebar: true,
        sidebarId: "search",
        sidebarWidth: 310,
        panel: true,
        panelId: "output",
        panelHeight: 280,
      });
      await workbench.restore();
      const restored = workbench.state.panelLayout;
      expect(restored.docks.right).toMatchObject({
        visible: true,
        size: 310,
        root: { active: "search" },
      });
      expect(restored.docks.bottom).toMatchObject({
        visible: true,
        size: 280,
        root: { active: "output" },
      });
      expect(restored.docks.left.visible).toBe(false);
      expect(workbench.state.activeGroup).toBe("editor-1");
      await workbench.persist();
      expect(
        (await persistence.get<any>(`layout:${filesystem.id}`)).panelLayout
          .version,
      ).toBe(1);
    } finally {
      workbench.dispose();
      documents.dispose();
      kernel.dispose();
    }
  });
});
