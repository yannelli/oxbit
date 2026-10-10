import { afterEach, expect, it, vi } from "vitest";
import { createKernel } from "@oxbit/core";
import { DocumentService } from "@oxbit/documents";
import { BrowserFileSystem, MemoryPersistence } from "@oxbit/host-browser";
import { WorkbenchController } from "@oxbit/workbench";
import { createFeature } from "./index.js";

const disposables: { dispose(): void }[] = [];
afterEach(() => {
  for (const disposable of disposables.splice(0).reverse()) disposable.dispose();
  vi.unstubAllGlobals();
});

async function setup() {
  vi.stubGlobal("requestAnimationFrame", () => 0);
  const kernel = createKernel();
  const persistence = new MemoryPersistence();
  const filesystem = new BrowserFileSystem(persistence);
  const documents = new DocumentService(filesystem, persistence, kernel);
  const workbench = new WorkbenchController(kernel, documents, filesystem, persistence);
  disposables.push(kernel, filesystem, documents, workbench);
  for (const directory of ["folder", "folder-copy"]) await filesystem.mkdir(directory);
  for (const path of ["folder/README.md", "folder/index.html", "folder-copy/keep.md"])
    await filesystem.write(path, "content", { expectedRevision: null });
  kernel.extensions.register(createFeature({ kernel, workbench, filesystem, documents }));
  await kernel.extensions.trigger("onStartup");
  const component = () => null;
  const path = "folder/README.md";
  await workbench.openFile(path, { preview: false });
  workbench.openView("preview:" + path, "README.md Preview", component, { path }, { path });
  workbench.openView(
    "html-preview:folder/index.html", "index.html Preview", component,
    { path: "folder/index.html" }, { path: "folder/index.html" },
  );
  workbench.openView("diff:" + path, path + " Changes", component, { path, staged: false });
  workbench.openView("diff:" + path + ":staged", path + " Changes", component, { path, staged: true });
  workbench.openView("compare:" + path, path + " Comparison", component, { path, mode: "disk" });
  workbench.openView("inspector:" + path, "Inspector", component, { path, section: "symbols" }, { path });
  workbench.openView("untouched", "Keep", component, { path: "folder-copy/keep.md" }, { path: "folder-copy/keep.md" });
  return { kernel, workbench, documents };
}

it("renames source and custom view tabs without changing opaque IDs", async () => {
  const { kernel, workbench, documents } = await setup();
  workbench.activateTab("g1", "preview:folder/README.md");
  await kernel.commands.execute("file.move", {
    from: "folder/README.md", to: "folder/GUIDE.md", confirmed: true,
  });
  const group = workbench.state.groups[0]!;
  expect(group.tabs.map((tab) => tab.id)).toEqual([
    "folder/GUIDE.md",
    "preview:folder/GUIDE.md",
    "html-preview:folder/index.html",
    "diff:folder/GUIDE.md",
    "diff:folder/GUIDE.md:staged",
    "compare:folder/GUIDE.md",
    "inspector:folder/README.md",
    "untouched",
  ]);
  expect(new Set(group.tabs.map((tab) => tab.id)).size).toBe(group.tabs.length);
  expect(group.active).toBe("preview:folder/GUIDE.md");
  expect(workbench.activeTab()).toMatchObject({
    path: "folder/GUIDE.md", props: { path: "folder/GUIDE.md" }, title: "GUIDE.md Preview",
  });
  expect(group.tabs.find((tab) => tab.id === "diff:folder/GUIDE.md:staged")).toMatchObject({
    title: "folder/GUIDE.md Changes", props: { path: "folder/GUIDE.md", staged: true },
  });
  expect(group.tabs.find((tab) => tab.id === "compare:folder/GUIDE.md")).toMatchObject({
    title: "folder/GUIDE.md Comparison", props: { path: "folder/GUIDE.md", mode: "disk" },
  });
  expect(group.tabs.find((tab) => tab.id === "inspector:folder/README.md")).toMatchObject({
    title: "Inspector", path: "folder/GUIDE.md", props: { path: "folder/GUIDE.md", section: "symbols" },
  });
  expect(documents.get("folder/GUIDE.md")?.path).toBe("folder/GUIDE.md");
});

it("remaps directory descendants and the active diff while preserving sibling paths", async () => {
  const { kernel, workbench } = await setup();
  workbench.set({ expanded: ["folder", "folder-copy"] });
  workbench.activateTab("g1", "diff:folder/README.md:staged");
  await kernel.commands.execute("file.move", {
    from: "folder", to: "renamed", confirmed: true,
  });
  const group = workbench.state.groups[0]!;
  expect(group.active).toBe("diff:renamed/README.md:staged");
  expect(workbench.activeTab()).toMatchObject({
    props: { path: "renamed/README.md", staged: true }, title: "renamed/README.md Changes",
  });
  expect(group.tabs.find((tab) => tab.id === "html-preview:renamed/index.html")).toMatchObject({
    path: "renamed/index.html", props: { path: "renamed/index.html" }, title: "index.html Preview",
  });
  expect(group.tabs.find((tab) => tab.id === "untouched")).toMatchObject({
    path: "folder-copy/keep.md", props: { path: "folder-copy/keep.md" }, title: "Keep",
  });
  expect(workbench.state.expanded).toEqual(["renamed", "folder-copy"]);
});
