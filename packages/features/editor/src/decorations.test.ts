import { afterEach, describe, expect, it, vi } from "vitest";
import { createKernel } from "../../../core/src/index";
import { EditorState } from "@codemirror/state";
import { contributedDecorations } from "./decorations.js";
const kernels: ReturnType<typeof createKernel>[] = [];
afterEach(() => {
  for (const kernel of kernels.splice(0)) kernel.dispose();
});
describe("contributed editor decorations", () => {
  it("creates document-specific extensions and removes them after teardown", () => {
    const kernel = createKernel();
    kernels.push(kernel);
    const createExtensions = vi.fn(() => [EditorState.tabSize.of(8)]);
    const registration = kernel.contributions.register({
      id: "lens",
      kind: "editorDecoration",
      title: "Lens",
      data: { createExtensions },
    });
    const document = { id: "doc1", path: "one.ts" };
    const extensions = contributedDecorations(kernel, document);
    expect(createExtensions).toHaveBeenCalledWith(document);
    expect(EditorState.create({ extensions }).facet(EditorState.tabSize)).toBe(
      8,
    );
    registration.dispose();
    expect(contributedDecorations(kernel, document)).toEqual([]);
  });
  it("isolates a failing decoration contribution", () => {
    const kernel = createKernel();
    kernels.push(kernel);
    kernel.contributions.register({
      id: "broken",
      kind: "editorDecoration",
      title: "Broken",
      data: {
        createExtensions() {
          throw new Error("failed");
        },
      },
    });
    const error = vi.fn();
    expect(
      contributedDecorations(kernel, { id: "doc", path: "one.ts" }, error),
    ).toEqual([]);
    expect(error).toHaveBeenCalledWith("Broken: failed");
  });
});
