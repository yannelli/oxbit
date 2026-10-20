import { describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import { CURSOR, cleanCompletion, cleanEdit, completionPrompt, completionSystem, contextWindow, editPrompt, nearbyProblems, openFileContext, unwrap } from "./prompt.js";

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

  it("drops a comment marker the line already ends with", () => {
    expect(cleanCompletion("// add two numbers", { prefix: "x();\n// ", suffix: "" })).toBe("add two numbers");
    expect(cleanCompletion("total = 1", { prefix: "let tot", suffix: "" })).toBe("al = 1");
    expect(cleanCompletion("b + 1", { prefix: "a = b", suffix: "" })).toBe("b + 1");
  });

  it("drops leading newlines after a comment marker or on a blank line, and keeps them after code", () => {
    expect(cleanCompletion("\n\nadd two numbers", { prefix: "// ", suffix: "" })).toBe("add two numbers");
    expect(cleanCompletion("\n  \nconst a = 1;", { prefix: "x();\n", suffix: "" })).toBe("const a = 1;");
    expect(cleanCompletion("\n  return 1;\n}", { prefix: "function f() {", suffix: "" })).toBe("\n  return 1;\n}");
    expect(cleanCompletion("\n    (sum, item) => sum + item,\n    0", { prefix: "items.reduce(", suffix: ");" }, 1)).toBe("(sum, item) => sum + item,");
  });

  it("drops lines that repeat the code before or after the cursor", () => {
    const before = "function add(a, b) {\n  return a + b;\n}\n";
    expect(cleanCompletion("}\n\nconst sum = add(1, 2);", { prefix: "function add(a, b) {\n  return a + b;\n}\n", suffix: "" })).toBe("}\n\nconst sum = add(1, 2);");
    expect(cleanCompletion("return a + b;\n}\nconst sum = add(1, 2);", { prefix: before, suffix: "" })).toBe("const sum = add(1, 2);");
    const after = "\nfunction multiply(a, b) {\n  return a * b;\n}\n";
    expect(cleanCompletion("const sum = add(1, 2);\nfunction multiply(a, b) {\n  return a", { prefix: before, suffix: after }, 4)).toBe("const sum = add(1, 2);");
    expect(cleanCompletion("foo() {\n  return 1;\n}", { prefix: "class A {\n  ", suffix: "\n}\n" })).toBe("foo() {\n  return 1;\n}");
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

describe("completion context options", () => {
  const doc = Text.of(Array.from({ length: 10 }, (_, index) => `line ${index + 1}`));
  const cursor = doc.line(5).from + 4;

  it("limits the code to the lines around the cursor", () => {
    expect(contextWindow(doc, cursor, { linesBefore: 1, linesAfter: 1, tokens: 1000 }))
      .toEqual({ prefix: "line 4\nline", suffix: " 5\nline 6", firstLine: 4, lastLine: 6 });
    expect(contextWindow(doc, cursor, { linesBefore: 0, linesAfter: 0, tokens: 1000 })).toMatchObject({ prefix: "line", suffix: " 5" });
  });

  it("drops whole lines farthest from the cursor to fit the token budget", () => {
    const window = contextWindow(doc, cursor, { linesBefore: 10, linesAfter: 10, tokens: 6 });
    expect(window.prefix).toBe("line 3\nline 4\nline");
    expect(window.suffix).toBe(" 5");
    expect(window.prefix.length + window.suffix.length).toBeLessThanOrEqual(24);
  });

  it("keeps errors and warnings on the context lines", () => {
    const at = (line: number, severity: number, message: string) => ({ range: { start: { line: line - 1, character: 0 } }, severity, message });
    expect(nearbyProblems([at(2, 1, "outside"), at(4, 1, "Cannot find name 'x'.\nmore"), at(5, 2, "Unused"), at(6, 3, "info")], 3, 6))
      .toEqual(["Line 4 (error): Cannot find name 'x'.", "Line 5 (warning): Unused"]);
  });

  it("shares the open file budget and skips empty files", () => {
    const files = openFileContext([{ path: "a.ts", text: "a1\na2\na3" }, { path: "b.ts", text: " " }, { path: "c.ts", text: "c1" }], 2);
    expect(files).toEqual([{ path: "a.ts", text: "a1" }, { path: "c.ts", text: "c1" }]);
  });

  it("adds the chosen sections and leaves out the path when asked", () => {
    const prompt = completionPrompt({ path: "a.ts", prefix: "x", suffix: "", includePath: false, problems: ["Line 1 (error): bad"], openFiles: [{ path: "b.ts", text: "b" }] });
    expect(prompt).toBe(`Open file b.ts:\n<file>b</file>\n\nProblems in this code:\nLine 1 (error): bad\n\nx${CURSOR}`);
  });

  it("asks for one line and adds the user's instructions", () => {
    const system = completionSystem({ maxLines: 1, instructions: " Use tabs. " });
    expect(system).toContain("Complete only the rest of the current line.");
    expect(system.endsWith("Instructions from the user:\nUse tabs.")).toBe(true);
    expect(completionSystem({ maxLines: 2 })).toContain("Reply with at most 2 lines.");
    expect(completionSystem({ maxLines: 2 })).not.toContain("Instructions");
  });

  it("cuts a suggestion to the line limit", () => {
    expect(cleanCompletion("a\nb\nc", { prefix: "", suffix: "" }, 2)).toBe("a\nb");
  });
});
