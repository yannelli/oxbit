import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error plain-node artwork script without types
import { loadCaptures, pngDimensions, screenshotSets, slides, validateStoreCopy } from "../scripts/ios/render-release-assets.mjs";
import copy from "../design/releases/v0.3.1/store-copy.json";

describe("iOS release artwork", () => {
  it("keeps App Store copy within field limits", () => {
    expect(() => validateStoreCopy(copy)).not.toThrow();
    expect(() => validateStoreCopy({ ...copy, subtitle: "a".repeat(31) })).toThrow("subtitle");
    expect(() => validateStoreCopy({ ...copy, keywords: "a".repeat(101) })).toThrow("keywords");
    expect(() => validateStoreCopy({ ...copy, supportUrl: "http://example.com" })).toThrow("HTTPS");
    expect(() => validateStoreCopy({ ...copy, privacyPolicyUrl: "http://example.com/privacy" })).toThrow("HTTPS");
  });

  it("rejects missing copy and invalid PNG inputs", () => {
    expect(() => validateStoreCopy({ ...copy, name: "" })).toThrow("name");
    expect(() => pngDimensions(Buffer.from("not an image"))).toThrow("PNG");
    expect(() => pngDimensions(Buffer.alloc(33))).toThrow("PNG");
  });

  it("loads a selected device and keeps browser captures marked as drafts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oxbit-capture-selection-"));
    const set = screenshotSets[1];
    try {
      await mkdir(join(directory, set.device));
      for (const [index, slide] of slides.entries()) {
        const png = Buffer.alloc(33);
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
        png.writeUInt32BE(set.width, 16);
        png.writeUInt32BE(set.height, 20);
        png[32] = index;
        await writeFile(join(directory, set.device, `${slide.id}.png`), png);
      }
      const captures = await loadCaptures(directory, [set], false);
      expect(captures.size).toBe(5);
      expect([...captures.values()].every(capture => capture.nativeCapture === false)).toBe(true);
      await expect(loadCaptures(directory)).rejects.toThrow("ENOENT");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects wrong-size and repeated captures before exporting", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oxbit-captures-"));
    try {
      await mkdir(join(directory, "iphone"));
      const png = Buffer.alloc(33);
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
      png.writeUInt32BE(390, 16);
      png.writeUInt32BE(844, 20);
      await writeFile(join(directory, "iphone/01-editor.png"), png);
      await expect(loadCaptures(directory)).rejects.toThrow("dimensions");
      png.writeUInt32BE(1320, 16);
      png.writeUInt32BE(2868, 20);
      await writeFile(join(directory, "iphone/01-editor.png"), png);
      await writeFile(join(directory, "iphone/02-files.png"), png);
      await expect(loadCaptures(directory)).rejects.toThrow("Duplicate");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
