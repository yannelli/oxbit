import { describe, it, expect } from "vitest";
import { resolvePreviewLink, headingId, scrollFraction, externalPreviewResource, previewResourcePolicy } from "./policy.js";
describe("Preview resource trust", () => {
  it("requires explicit trust for external HTTP resources and preserves encoded URLs", () => {
    const url = "https://example.com/image.svg?signature=a%2Bb%26c";
    expect(externalPreviewResource(url, "local")).toBeUndefined();
    expect(externalPreviewResource(url, "external")).toBe(url);
    expect(externalPreviewResource("//example.com/style.css", "external")).toBe("https://example.com/style.css");
    expect(externalPreviewResource("http://localhost:3000/image.png", "external")).toBe("http://localhost:3000/image.png");
  });

  it("keeps credentials, executable protocols and malformed URLs blocked when trusted", () => {
    for (const url of ["javascript:alert(1)", "mailto:hello@example.com", "file:///private/image.png",
      "https://user:password@example.com/image.png", "https://example.com/\\image", "https://example.com/\nimage",
      "%68ttps://example.com/image.png", "../image.png"])
      expect(externalPreviewResource(url, "external")).toBeUndefined();
  });

  it("grants external sources to passive resources and revokes them in local mode", () => {
    expect(previewResourcePolicy("local")).toBe("style-src 'unsafe-inline' data:; img-src data:; font-src data:; media-src data:");
    expect(previewResourcePolicy("external")).toBe("style-src 'unsafe-inline' data: https: http:; img-src data: https: http:; font-src data: https: http:; media-src data: https: http:");
  });
});

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
