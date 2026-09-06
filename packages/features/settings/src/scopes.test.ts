import { afterEach, describe, expect, it } from "vitest";
import { createKernel } from "../../../core/src/index";
import { scopedSetting } from "./scopes.js";
const kernels: ReturnType<typeof createKernel>[] = [];
afterEach(() => {
  for (const kernel of kernels.splice(0)) kernel.dispose();
});
describe("settings scope editing", () => {
  it("displays user values independently of workspace overrides and marks explicit defaults", () => {
    const kernel = createKernel();
    kernels.push(kernel);
    const setting = {
      id: "editor.tabSize",
      title: "Tab size",
      type: "number" as const,
      default: 2,
    };
    kernel.configuration.register(setting);
    kernel.configuration.set(setting.id, 4, "user");
    kernel.configuration.set(setting.id, 8, "workspace");
    expect(scopedSetting(kernel, setting, "user")).toEqual({
      value: 4,
      modified: true,
    });
    expect(scopedSetting(kernel, setting, "workspace")).toEqual({
      value: 8,
      modified: true,
    });
    kernel.configuration.set(setting.id, 2, "workspace");
    expect(scopedSetting(kernel, setting, "workspace")).toEqual({
      value: 2,
      modified: true,
    });
    kernel.configuration.reset(setting.id, "workspace");
    expect(scopedSetting(kernel, setting, "workspace")).toEqual({
      value: 4,
      modified: false,
    });
  });
  it("resolves language values in the five-layer order for the selected scope", () => {
    const kernel = createKernel();
    kernels.push(kernel);
    const setting = {
      id: "editor.tabSize",
      title: "Tab size",
      type: "number" as const,
      default: 2,
    };
    kernel.configuration.register(setting);
    kernel.configuration.set(setting.id, 3, "user");
    kernel.configuration.set(setting.id, 4, "workspace");
    kernel.configuration.set(setting.id, 5, "user", "typescript");
    kernel.configuration.set(setting.id, 6, "workspace", "typescript");
    expect(scopedSetting(kernel, setting, "user", "typescript")).toEqual({
      value: 5,
      modified: true,
    });
    expect(scopedSetting(kernel, setting, "workspace", "typescript")).toEqual({
      value: 6,
      modified: true,
    });
    kernel.configuration.reset(setting.id, "workspace", "typescript");
    expect(scopedSetting(kernel, setting, "workspace", "typescript")).toEqual({
      value: 5,
      modified: false,
    });
  });
});
