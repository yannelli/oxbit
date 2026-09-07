import { afterEach, describe, expect, it } from "vitest";
import { createKernel } from "@oxbit/core";
import {
  documentViewFor,
  menuContributions,
  themeVariables,
} from "./contributions.js";
const kernels: ReturnType<typeof createKernel>[] = [];
afterEach(() => {
  for (const kernel of kernels.splice(0)) kernel.dispose();
});
const setup = () => {
  const kernel = createKernel();
  kernels.push(kernel);
  return kernel;
};
describe("contribution surfaces", () => {
  it("routes matching custom documents and ignores failing matchers", () => {
    const kernel = setup();
    kernel.contributions.register({
      id: "bad",
      kind: "documentView",
      title: "Bad",
      component: () => null,
      data: {
        matches() {
          throw new Error("bad matcher");
        },
      },
    });
    kernel.contributions.register({
      id: "report",
      kind: "documentView",
      title: "Report",
      component: () => null,
      data: { extensions: [".bundle.json"] },
    });
    expect(documentViewFor(kernel, "build/APP.BUNDLE.JSON")?.id).toBe("report");
    expect(documentViewFor(kernel, "index.ts")).toBeUndefined();
  });
  it("limits context menu contributions per extension without dropping other owners", async () => {
    const kernel = setup();
    for (const [id, count] of [["a", 5], ["b", 1]] as const) {
      kernel.extensions.register({
        manifest: { manifestVersion: 1, id: "test." + id, name: id, version: "1.0.0", sdk: "^1.0.0", environments: ["browser"], activation: [], capabilities: [] },
        activate(ctx) {
          for (let index = 0; index < count; index++)
            ctx.contributions.register({ id: id === "a" ? "a" + index : "b", kind: "menu", title: id, location: "editor", command: "command" });
        },
      });
      await kernel.extensions.activate("test." + id);
    }
    expect(menuContributions(kernel, "editor").map(item => item.id)).toEqual(["a0", "a1", "a2", "b"]);
    await kernel.extensions.disable("test.a");
    expect(menuContributions(kernel, "editor").map(item => item.id)).toEqual(["b"]);
  });
  it("applies only CSS variables from the selected theme", () => {
    const kernel = setup();
    kernel.configuration.register({
      id: "workbench.colorTheme",
      title: "Theme",
      type: "string",
      default: "Custom",
    });
    kernel.contributions.register({
      id: "custom",
      kind: "theme",
      title: "Custom",
      data: {
        variables: {
          "--bg-editor": "#123456",
          background: "red",
          "--invalid": 9,
        },
      },
    });
    expect(themeVariables(kernel)).toEqual({ "--bg-editor": "#123456" });
  });
});
