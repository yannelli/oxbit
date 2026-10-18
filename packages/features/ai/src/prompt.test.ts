import { describe, expect, it } from "vitest";
import { CURSOR, cleanCompletion, cleanEdit, completionPrompt, editPrompt, unwrap } from "./prompt.js";

describe("completion prompts", () => {
  it("marks the cursor between the prefix and suffix", () => {
    const prompt = completionPrompt({ path: "src/add.ts", language: "typescript", prefix: "function add(a, b) {\n  ", suffix: "\n}" });
    expect(prompt).toBe(`Path: src/add.ts\nLanguage: typescript\n\nfunction add(a, b) {\n  ${CURSOR}\n}`);
  });

  it("wraps the selection and the instruction for an edit", () => {
    const prompt = editPrompt({ path: "a.py", prefix: "x = 1\n", selection: "print(x)\n", suffix: "", instruction: "use f-strings" });
    expect(prompt).toContain("<selection>print(x)\n</selection>");
    expect(prompt.endsWith("Instruction: use f-strings")).toBe(true);
  });
});

describe("cleanCompletion", () => {
  const context = { prefix: "const total = items.reduce(", suffix: ");\nexport default total;" };

  it("removes a code fence and text that repeats the suffix", () => {
    expect(cleanCompletion("```ts\n(sum, item) => sum + item.price, 0);\n```", context)).toBe("(sum, item) => sum + item.price, 0");
  });

  it("removes the current line when the model repeats it", () => {
    expect(cleanCompletion("const total = items.reduce((a, b) => a + b, 0", context)).toBe("(a, b) => a + b, 0");
  });

  it("keeps the text after an echoed cursor marker", () => {
    expect(cleanCompletion(`items.reduce(${CURSOR}(a, b) => a + b, 0`, context)).toBe("(a, b) => a + b, 0");
  });

  it("returns nothing for whitespace or text already after the cursor", () => {
    expect(cleanCompletion("  \n", context)).toBe("");
    expect(cleanCompletion(");", context)).toBe("");
  });

  it("caps long replies at 24 lines", () => {
    const reply = Array.from({ length: 40 }, (_, index) => `line${index}`).join("\n");
    expect(cleanCompletion(reply, { prefix: "", suffix: "" }).split("\n")).toHaveLength(24);
  });
});

describe("cleanEdit", () => {
  it("unwraps fences and selection tags", () => {
    expect(unwrap("<selection>\nfoo\n</selection>", ["selection"])).toBe("foo");
    expect(cleanEdit("```python\nprint(f\"{x}\")\n```", "print(x)\n")).toBe("print(f\"{x}\")\n");
  });

  it("matches whether the selection ended with a newline", () => {
    expect(cleanEdit("a + b\n\n", "a+b")).toBe("a + b");
    expect(cleanEdit("a + b", "a+b\n")).toBe("a + b\n");
  });
});
