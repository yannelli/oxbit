import { describe, expect, it } from "vitest";
import { fenceHostPath, fenceLanguage, fencePath, fenceText, findFences, fromFenceOffset, toFenceOffset } from "./fences.js";

describe("fenceLanguage", () => {
  it("resolves ids, extensions, aliases and attribute syntax", () => {
    expect(fenceLanguage("ts")?.id).toBe("typescript");
    expect(fenceLanguage("typescript title=a.ts")?.id).toBe("typescript");
    expect(fenceLanguage("{.tsx}")?.id).toBe("typescriptreact");
    expect(fenceLanguage("bash")?.id).toBe("shellscript");
    expect(fenceLanguage("shell")?.id).toBe("shellscript");
    expect(fenceLanguage("Python")?.id).toBe("python");
    expect(fenceLanguage("")).toBeUndefined();
    expect(fenceLanguage("text")).toBeUndefined();
    expect(fenceLanguage("unknown")).toBeUndefined();
  });
});

describe("findFences", () => {
  it("finds Markdown fences and maps offsets both ways", () => {
    const text = "# Title\n\n```ts\nconst a = 1;\n\nlet b = a;\n```\n\n~~~\nplain\n~~~\n```json\n{}\n```\n";
    const fences = findFences(text, "markdown");
    expect(fences.map(fence => [fence.index, fence.language.id, fenceText(text, fence)])).toEqual([[0, "typescript", "const a = 1;\n\nlet b = a;"], [1, "json", "{}"]]);
    const [fence] = fences, host = text.indexOf("let b");
    expect(toFenceOffset(fence, host)).toBe(14);
    expect(fromFenceOffset(fence, 14)).toBe(host);
    expect(toFenceOffset(fence, text.indexOf("# Title"))).toBeUndefined();
    expect(text.slice(fence.from, fence.to)).toBe("```ts\nconst a = 1;\n\nlet b = a;\n```");
  });

  it("strips list indentation and blockquote markers, keeps unclosed fences, and handles CRLF", () => {
    const list = "- item\n\n  ```js\n  call();\n  ```\n";
    expect(findFences(list, "markdown").map(fence => fenceText(list, fence))).toEqual(["call();"]);
    const quote = "> ```py\n> print(1)\n> ```\n";
    expect(findFences(quote, "markdown").map(fence => fenceText(quote, fence))).toEqual(["print(1)"]);
    const unclosed = "```ts\nlet a = 1;\nlet b = 2;";
    expect(findFences(unclosed, "markdown").map(fence => fenceText(unclosed, fence))).toEqual(["let a = 1;\nlet b = 2;"]);
    const crlf = "```ts\r\nlet a = 1;\r\n```\r\n";
    expect(findFences(crlf, "markdown").map(fence => fenceText(crlf, fence))).toEqual(["let a = 1;"]);
  });

  it("ignores indented code, longer inner fences and fences in non-comment code", () => {
    expect(findFences("    ```ts\n    let a;\n    ```\n", "markdown")).toEqual([]);
    const nested = "````md\n```ts\nlet a;\n```\n````\n";
    expect(findFences(nested, "markdown").map(fence => [fence.language.id, fenceText(nested, fence)])).toEqual([["markdown", "```ts\nlet a;\n```"]]);
    expect(findFences("const s = `\n```ts\nlet a;\n```\n`;\n", "typescript")).toEqual([]);
  });

  it("finds fences inside doc comments and line comments", () => {
    const jsdoc = "/**\n * Example:\n * ```ts\n * const a = add(1, 2);\n *\n * a.toFixed();\n * ```\n */\nexport function add() {}\n";
    const [fence] = findFences(jsdoc, "typescript");
    expect(fenceText(jsdoc, fence)).toBe("const a = add(1, 2);\n\na.toFixed();");
    expect(fromFenceOffset(fence, fenceText(jsdoc, fence).indexOf("toFixed"))).toBe(jsdoc.indexOf("toFixed"));
    const rust = "/// ```bash\n/// echo hi\n/// ```\nfn main() {}\n";
    expect(findFences(rust, "rust").map(fence => fenceText(rust, fence))).toEqual(["echo hi"]);
    const unclosed = "/**\n * ```ts\n * let a;\n */\n";
    expect(findFences(unclosed, "typescript").map(fence => fenceText(unclosed, fence))).toEqual(["let a;"]);
  });
});

describe("fencePath", () => {
  it("round-trips the host path", () => {
    const [fence] = findFences("```tsx\n<a />\n```", "markdown");
    expect(fencePath("docs/README.md", fence)).toBe("docs/README.md.fence-0.tsx");
    expect(fenceHostPath("docs/README.md.fence-0.tsx")).toBe("docs/README.md");
    expect(fenceHostPath("src/app.ts")).toBeUndefined();
  });
});
