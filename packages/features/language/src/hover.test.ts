import { describe, expect, it } from "vitest";
import { renderHover } from "./hover";

describe("hover documentation", () => {
  it("renders and highlights fenced signatures with prose", () => {
    const html = renderHover({ kind: "markdown", value: "```typescript\nfunction liveDaemon(dataDir: string): Promise<Daemon | undefined>\n```\n\nReturns the **running daemon**. See `dataDir`." });
    expect(html).not.toContain("```");
    expect(html).toContain('class="lsp-code-language">typescript');
    expect(html).toContain('class="tok-keyword">function');
    expect(html).toContain("<strong>running daemon</strong>");
    expect(html).toContain("<code>dataDir</code>");
  });
  it("preserves literal plaintext and legacy language blocks", () => {
    expect(renderHover({ kind: "plaintext", value: "**literal** <T>\nnext" })).toContain("**literal** &lt;T&gt;\nnext");
    const html = renderHover([{ language: "typescript", value: "const count: number" }, "A **count**"]);
    expect(html).toContain("lsp-hover-divider");
    expect(html).toContain("<strong>count</strong>");
  });
  it("escapes HTML and blocks executable links and external images", () => {
    const html = renderHover('<script>alert(1)</script>\n\n[bad](javascript:alert(1)) [command](command:run) ![remote](https://example.com/pixel) [docs](https://example.com/docs)');
    expect(html).not.toMatch(/<script|<img|href="(?:javascript|command):/);
    expect(html).toContain('href="https://example.com/docs" target="_blank" rel="noopener noreferrer"');
    expect(renderHover({ language: '"><img src=x>', value: "<script>" })).not.toContain("<img");
  });
});
