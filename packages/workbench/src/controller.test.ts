import { afterEach, describe, expect, it, vi } from "vitest";
import { createKernel } from "@zapp/core";
import { DocumentService } from "@zapp/documents";
import { BrowserFileSystem, MemoryPersistence } from "@zapp/host-browser";
import { WorkbenchController } from "./controller.js";
const disposables: { dispose(): void }[] = [];
afterEach(() => {
  for (const disposable of disposables.splice(0).reverse())
    disposable.dispose();
  vi.unstubAllGlobals();
});
async function setup() {
  vi.stubGlobal("requestAnimationFrame", () => 0);
  const kernel = createKernel();
  const persistence = new MemoryPersistence();
  const filesystem = new BrowserFileSystem(persistence);
  await filesystem.write("one.ts", "const one = 1;", {
    expectedRevision: null,
  });
  await filesystem.write("two.ts", "const two = 2;", {
    expectedRevision: null,
  });
  const documents = new DocumentService(filesystem, persistence, kernel);
  const workbench = new WorkbenchController(
    kernel,
    documents,
    filesystem,
    persistence,
  );
  disposables.push(kernel, documents, workbench);
  return { kernel, persistence, filesystem, documents, workbench };
}
describe("workbench document and contribution lifecycle", () => {
  it("activates deferred panels from their declared view trigger", async () => {
    const { workbench, kernel } = await setup();
    kernel.extensions.register({
      manifest: {
        manifestVersion: 1,
        id: "example.deferred",
        name: "Deferred",
        version: "1.0.0",
        sdk: "^1.0.0",
        environments: ["browser"],
        activation: ["onView:deferred"],
        capabilities: [],
      },
      activate(ctx) {
        ctx.contributions.register({
          id: "deferred",
          kind: "panel",
          title: "Deferred",
          component: () => null,
        });
      },
    });
    expect(kernel.contributions.list("panel")).toHaveLength(0);
    workbench.openPanel("deferred");
    await vi.waitFor(() =>
      expect(
        kernel.contributions.list("panel").map((item) => item.id),
      ).toContain("deferred"),
    );
    expect(workbench.state.panelId).toBe("deferred");
  });
  it("bounds notification actions and carries TTL and source metadata", async () => {
    const { workbench } = await setup();
    workbench.notify("Done", "info", {
      ttl: 1200,
      source: "Example",
      actions: [0, 1, 2, 3].map((index) => ({
        title: "Action " + index,
        command: "example." + index,
      })),
    });
    expect(workbench.state.notifications.at(-1)).toMatchObject({
      message: "Done",
      ttl: 1200,
      source: "Example",
    });
    expect(workbench.state.notifications.at(-1)?.actions).toHaveLength(3);
    workbench.showContextMenu("terminal", 10, 20, ["terminal.new"]);
    expect(workbench.state.menu).toMatchObject({
      location: "terminal",
      x: 10,
      y: 20,
      ids: ["terminal.new"],
    });
  });

  it("replaces a clean preview and targets pinning to the clicked tab", async () => {
    const { workbench, documents } = await setup();
    await workbench.openFile("one.ts", { preview: true });
    await workbench.openFile("two.ts", { preview: true });
    expect(workbench.state.groups[0]!.tabs.map((tab) => tab.id)).toEqual([
      "two.ts",
    ]);
    expect(documents.get("one.ts")).toBeUndefined();
    await workbench.openFile("one.ts", { preview: false });
    workbench.pin("g1", "two.ts");
    expect(
      workbench.state.groups[0]!.tabs.find((tab) => tab.id === "two.ts"),
    ).toMatchObject({ pinned: true, preview: false });
    expect(workbench.activePath()).toBe("one.ts");
  });
  it("retains dirty text when one of two views closes and prompts on the final view", async () => {
    const { workbench, documents } = await setup();
    await workbench.openFile("one.ts");
    const second = workbench.split("row")!;
    documents.get("one.ts")!.replace("unsaved");
    await workbench.closeTab("g1", "one.ts");
    expect(documents.get("one.ts")!.text.toString()).toBe("unsaved");
    const closing = workbench.closeTab(second, "one.ts");
    expect(workbench.state.dialog?.title).toContain("Save changes");
    workbench.finishDialog("Cancel");
    await closing;
    expect(workbench.activePath()).toBe("one.ts");
  });
  it("keeps source and custom preview tabs separate and removes extension views on disablement", async () => {
    const { workbench, kernel } = await setup();
    const component = () => null;
    const registration = kernel.contributions.register({
      id: "preview",
      kind: "documentView",
      title: "Preview",
      component,
    });
    await workbench.openFile("one.ts");
    const second = workbench.split("column")!;
    workbench.openView(
      "preview:one.ts",
      "Preview",
      component,
      { path: "one.ts" },
      { groupId: second, path: "one.ts", contributionId: "preview" },
    );
    await workbench.openFile("one.ts", { groupId: second });
    expect(workbench.activeTab()?.component).toBeUndefined();
    expect(workbench.state.groups[1]!.tabs).toHaveLength(2);
    registration.dispose();
    workbench.synchronizeContributions();
    expect(
      workbench.state.groups
        .flatMap((group) => group.tabs)
        .some((tab) => tab.contributionId === "preview"),
    ).toBe(false);
  });
  it("opens missing files in a retryable tab and toggles a panel", async () => {
    const { workbench } = await setup();
    await workbench.openFile("missing.ts");
    expect(workbench.activeTab()).toMatchObject({
      path: "missing.ts",
      error: expect.any(String),
    });
    workbench.togglePanel("terminal");
    expect(workbench.state.panel).toBe(true);
    workbench.togglePanel("terminal");
    expect(workbench.state.panel).toBe(false);
  });
  it("publishes metadata transitions without rerendering for every text transaction", async () => {
    const { workbench, documents } = await setup();
    await workbench.openFile("one.ts");
    workbench.documentChanged();
    const listener = vi.fn();
    const stop = workbench.subscribe(listener);
    documents.get("one.ts")!.replace("first change");
    workbench.documentChanged();
    documents.get("one.ts")!.replace("second change");
    workbench.documentChanged();
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
  });
  it("restores contributed tabs and normalizes a removed active group", async () => {
    const { workbench, kernel, persistence } = await setup();
    const component = () => null;
    kernel.contributions.register({
      id: "settings",
      kind: "tab",
      title: "Settings",
      component,
    });
    workbench.openView("settings", "Settings", component);
    await workbench.persist();
    const saved = await persistence.get<any>(
      "layout:" + workbench.filesystem.id,
    );
    expect(saved.groups[0].tabs[0].contributionId).toBe("settings");
    saved.activeGroup = "removed";
    await persistence.set("layout:" + workbench.filesystem.id, saved);
    await workbench.restore();
    expect(workbench.activeTab()?.component).toBe(component);
    expect(workbench.state.activeGroup).toBe("g1");
  });
});
