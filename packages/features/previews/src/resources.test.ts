import { describe, expect, it, vi } from "vitest";
import type { FileSystem } from "@oxbit/sdk";
import { createPreviewResources } from "./resources.js";
import type { PreviewResourceTrust } from "./policy.js";

function fixture(trust: PreviewResourceTrust = "local") {
  const readBytes = vi.fn(async () => new Uint8Array([1, 2, 3]));
  const readText = vi.fn(async () => 'body { background: url("../images/logo.png") }');
  const dependencies = new Set<string>();
  const controller = new AbortController();
  const resources = createPreviewResources({
    path: "docs/index.html", trust, readText, dependencies, signal: controller.signal,
    filesystem: { readBytes } as unknown as FileSystem,
  });
  return { ...resources, readBytes, readText, dependencies, controller };
}

describe("Shared preview resources", () => {
  it("loads and caches local images while tracking workspace dependencies", async () => {
    const engine = fixture();
    expect(await engine.resource("docs/guide.md", "images/logo.png")).toBe("data:image/png;base64,AQID");
    await engine.resource("docs/index.html", "images/logo.png");
    expect(engine.readBytes).toHaveBeenCalledTimes(1);
    expect([...engine.dependencies]).toEqual(["docs/images/logo.png"]);
  });

  it("blocks remote resources by default without reading them as workspace files", async () => {
    const engine = fixture();
    expect(await engine.resource("docs/guide.md", "https://example.com/image.png")).toBe("data:,");
    expect(engine.readBytes).not.toHaveBeenCalled();
    expect(engine.warnings.size).toBe(1);
  });

  it("allows remote styles and assets under explicit trust without granting workspace escapes", async () => {
    const engine = fixture("external");
    expect(await engine.resource("index.html", "https://example.com/style.css", true)).toBe("https://example.com/style.css");
    expect(await engine.resource("index.html", "//example.com/image.png")).toBe("https://example.com/image.png");
    expect(await engine.resource("index.html", "../private.png")).toBe("data:,");
    expect(await engine.resource("index.html", "javascript:alert(1)")).toBe("data:,");
    expect(engine.readBytes).not.toHaveBeenCalled();
  });

  it("resolves local stylesheet assets relative to the stylesheet", async () => {
    const engine = fixture();
    const css = await engine.resource("docs/index.html", "css/style.css", true);
    expect(atob(css.split(",")[1]!)).toContain("data:image/png;base64,AQID");
    expect(engine.readText).toHaveBeenCalledWith("docs/css/style.css");
    expect(engine.readBytes).toHaveBeenCalledWith("docs/images/logo.png", expect.any(AbortSignal));
  });

  it("stops loading when the preview is replaced or its trust changes", async () => {
    const engine = fixture();
    engine.controller.abort();
    await expect(engine.resource("index.html", "image.png")).rejects.toThrow();
    expect(engine.readBytes).not.toHaveBeenCalled();
  });
});
