import { afterEach, describe, expect, it } from "vitest";
import { createKernel } from "@oxbit/core";
import {
  normalizeShortcut,
  resolveWorkbenchShortcut,
  shortcutCandidates,
} from "./shortcuts.js";
const kernels: ReturnType<typeof createKernel>[] = [];
afterEach(() => {
  for (const kernel of kernels.splice(0)) kernel.dispose();
});
const setup = () => {
  const kernel = createKernel();
  kernels.push(kernel);
  return kernel;
};
describe("workbench shortcut precedence", () => {
  it("normalizes platform aliases, modifier order, arrows, and chord keys", () => {
    expect(normalizeShortcut("Meta+Shift+P")).toBe(
      normalizeShortcut("Shift+Ctrl+p"),
    );
    expect(normalizeShortcut("Ctrl+Alt+Right")).toBe(
      normalizeShortcut("Ctrl+Alt+ArrowRight"),
    );
    expect(normalizeShortcut("Ctrl+K Enter")).toBe("ctrl+k enter");
  });
  it("uses user overrides and supports explicitly removing a binding", () => {
    const kernel = setup();
    kernel.commands.register({
      id: "one",
      title: "One",
      shortcut: "Ctrl+L",
      run() {},
    });
    kernel.commands.register({
      id: "two",
      title: "Two",
      shortcut: "Ctrl+L",
      priority: 10,
      run() {},
    });
    expect(
      resolveWorkbenchShortcut(kernel, { one: "Ctrl+L" }, "Ctrl+L")?.id,
    ).toBe("one");
    expect(
      shortcutCandidates(kernel, { one: "" }).some(
        (item) => item.command.id === "one",
      ),
    ).toBe(false);
  });
  it("consumes extension shortcuts with context and focus precedence", () => {
    const kernel = setup();
    kernel.commands.register({
      id: "editor.action",
      title: "Editor",
      shortcut: "Ctrl+K",
      run() {},
    });
    kernel.commands.register({
      id: "terminal.action",
      title: "Terminal",
      shortcut: "Ctrl+K",
      run() {},
    });
    kernel.commands.register({
      id: "extension.action",
      title: "Extension",
      run() {},
    });
    kernel.contributions.register({
      id: "external.key",
      kind: "shortcut",
      title: "External key",
      command: "extension.action",
      when: "custom",
      data: { key: "Ctrl+Q" },
    });
    expect(resolveWorkbenchShortcut(kernel, {}, "Ctrl+Q")).toBeUndefined();
    kernel.context.set("custom", true);
    expect(resolveWorkbenchShortcut(kernel, {}, "Ctrl+Q")?.id).toBe(
      "extension.action",
    );
    expect(resolveWorkbenchShortcut(kernel, {}, "Ctrl+K", "terminal")?.id).toBe(
      "terminal.action",
    );
    expect(resolveWorkbenchShortcut(kernel, {}, "Ctrl+K", "editor")?.id).toBe(
      "editor.action",
    );
  });
});
