import { afterEach, describe, expect, it } from "vitest";
import { createKernel } from "../../../core/src/index";
import { applyLayer, readLayer } from "./json-layer.js";

const kernels: ReturnType<typeof createKernel>[] = [];
afterEach(() => {
  for (const kernel of kernels.splice(0)) kernel.dispose();
});
function setup() {
  const kernel = createKernel();
  kernels.push(kernel);
  kernel.configuration.register({ id: "editor.tabSize", title: "Tab Size", type: "number", default: 2, min: 1 });
  kernel.configuration.register({ id: "editor.minimap", title: "Minimap", type: "boolean", default: true });
  kernel.configuration.register({ id: "editor.wordWrap", title: "Word Wrap", type: "string", default: "off" });
  return kernel;
}

describe("settings JSON layer", () => {
  it("sets changed keys, resets removed keys, and reads language layers", () => {
    const kernel = setup();
    kernel.configuration.set("editor.tabSize", 4, "workspace");
    kernel.configuration.set("editor.minimap", false, "workspace");
    kernel.configuration.set("editor.wordWrap", "on", "user", "markdown");
    const original = readLayer(kernel, "workspace");
    applyLayer(kernel, original, { "editor.tabSize": 8 }, "workspace");
    expect(readLayer(kernel, "workspace")).toEqual({ "editor.tabSize": 8 });
    expect(readLayer(kernel, "user", "markdown")).toEqual({ "editor.wordWrap": "on" });
    expect(readLayer(kernel, "workspace", "markdown")).toEqual({});
  });

  it("restores the snapshot when a write throws", () => {
    const kernel = setup();
    kernel.configuration.set("editor.tabSize", 4, "user");
    const original = readLayer(kernel, "user");
    expect(() => applyLayer(kernel, original, { "editor.minimap": false, "editor.tabSize": 0 }, "user")).toThrow(/range/);
    expect(readLayer(kernel, "user")).toEqual({ "editor.tabSize": 4 });
    expect(() => applyLayer(kernel, original, { "editor.tabSize": 4, "unknown.key": 1 }, "user")).toThrow(/Unknown setting/);
    expect(readLayer(kernel, "user")).toEqual({ "editor.tabSize": 4 });
  });
});
