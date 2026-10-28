import { afterEach, describe, expect, it } from "vitest";
import { createKernel } from "../../../core/src/index";
import { effectiveWordWrap, hangingColumns } from "./wrap-indent.js";

const kernels: ReturnType<typeof createKernel>[] = [];
afterEach(() => {
  for (const kernel of kernels.splice(0)) kernel.dispose();
});
function setup() {
  const kernel = createKernel();
  kernels.push(kernel);
  kernel.configuration.register({ id: "editor.wordWrap", title: "Word Wrap", type: "string", default: "off" });
  return kernel;
}

describe("hanging indent", () => {
  it("adds one indent unit to the leading whitespace", () => {
    expect(hangingColumns("const a = 1;", 2, 2)).toBe(2);
    expect(hangingColumns("    return value;", 4, 4)).toBe(8);
  });

  it("expands tabs to the next tab stop", () => {
    expect(hangingColumns("\tif (x)", 4, 4)).toBe(8);
    expect(hangingColumns("  \tif (x)", 4, 4)).toBe(8);
  });
});

describe("phone word wrap", () => {
  it("wraps on phones when the setting is left at its default", () => {
    const kernel = setup();
    expect(effectiveWordWrap(kernel, "typescript", true)).toBe("on");
    expect(effectiveWordWrap(kernel, "typescript", false)).toBe("off");
  });

  it("keeps an explicit user or language setting", () => {
    const kernel = setup();
    kernel.configuration.set("editor.wordWrap", "off", "user");
    expect(effectiveWordWrap(kernel, "typescript", true)).toBe("off");
    const other = setup();
    other.configuration.set("editor.wordWrap", "bounded", "user", "markdown");
    expect(effectiveWordWrap(other, "markdown", true)).toBe("bounded");
    expect(effectiveWordWrap(other, "typescript", true)).toBe("on");
  });
});
