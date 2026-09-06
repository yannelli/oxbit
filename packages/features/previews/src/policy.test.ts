import { describe, it, expect } from "vitest";
import { resolvePreviewLink, headingId, scrollFraction } from "./policy.js";
describe("Markdown resource policies", () => {
  it("resolves local links with fragments without leaving the workspace", () => {
    expect(resolvePreviewLink("docs/guide.md", "../README.md#usage")).toEqual({
      kind: "file",
      path: "README.md",
      anchor: "usage",
    });
    expect(resolvePreviewLink("docs/guide.md", "../../secret")).toMatchObject({
      kind: "blocked",
    });
    expect(resolvePreviewLink("README.md", "%2e%2e/private")).toMatchObject({
      kind: "blocked",
    });
  });
  it("rejects encoded and protocol-relative executable or external resources", () => {
    for (const url of [
      "javascript:alert(1)",
      "%6aavascript:alert(1)",
      "//other.example/file",
      "data:text/html,test",
      "https://user:password@example.com",
      "bad%zz",
      "x%5cy",
    ])
      expect(resolvePreviewLink("README.md", url)).toMatchObject({
        kind: "blocked",
      });
    expect(resolvePreviewLink("README.md", "https://example.com/docs")).toEqual(
      { kind: "external", url: "https://example.com/docs" },
    );
  });
  it("supports Unicode heading anchors and clamps synchronized scroll positions", () => {
    expect(headingId("Überblick & API")).toBe("überblick-api");
    expect(
      scrollFraction({ scrollTop: 50, scrollHeight: 300, clientHeight: 200 }),
    ).toBe(0.5);
    expect(
      scrollFraction({ scrollTop: 10, scrollHeight: 100, clientHeight: 100 }),
    ).toBe(1);
  });
});
