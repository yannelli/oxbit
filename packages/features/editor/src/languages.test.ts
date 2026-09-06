import { afterEach, describe, expect, it } from "vitest";
import { createKernel } from "../../../core/src/index";
import { contributedLanguage, editorLanguageId } from "./languages.js";
const kernels: ReturnType<typeof createKernel>[] = [];
afterEach(() => {
  for (const kernel of kernels.splice(0)) kernel.dispose();
});
describe("extension language definitions", () => {
  it("selects contributed syntax and configuration scopes by extension", () => {
    const kernel = createKernel();
    kernels.push(kernel);
    const syntax = [];
    const registration = kernel.contributions.register({
      id: "custom.lang",
      kind: "language",
      title: "Custom",
      data: { id: "custom", extensions: ["custom"], editorExtensions: syntax },
    });
    expect(editorLanguageId(kernel, "src/file.CUSTOM")).toBe("custom");
    expect(
      (contributedLanguage(kernel, "file.custom")?.data as any)
        .editorExtensions,
    ).toBe(syntax);
    registration.dispose();
    expect(editorLanguageId(kernel, "file.custom")).toBe("plaintext");
    expect(editorLanguageId(kernel, "main.ts")).toBe("typescript");
  });
});
