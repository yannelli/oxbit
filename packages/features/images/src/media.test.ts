import { describe, expect, it } from "vitest";
import {
  fitScale,
  formatBytes,
  formatZoom,
  isVector,
  mimeForPath,
  nextZoom,
  zoomSteps,
} from "./media.js";

describe("image media helpers", () => {
  it("maps extensions to types the browser can draw", () => {
    expect(mimeForPath("src/assets/Logo.PNG")).toBe("image/png");
    expect(mimeForPath("photo.jpeg")).toBe("image/jpeg");
    expect(mimeForPath("icon.svg")).toBe("image/svg+xml");
    expect(isVector("icon.svg")).toBe(true);
    expect(isVector("icon.png")).toBe(false);
  });
  it("claims neither extensionless names nor dotfiles that share an extension", () => {
    expect(mimeForPath("png")).toBeUndefined();
    expect(mimeForPath("assets/.png")).toBeUndefined();
    expect(mimeForPath("notes.txt")).toBeUndefined();
    expect(mimeForPath("archive.png.gz")).toBeUndefined();
  });
  it("steps through the zoom ladder and stops at both ends", () => {
    expect(nextZoom(1, 1)).toBe(1.5);
    expect(nextZoom(1, -1)).toBe(0.75);
    expect(nextZoom(0.8, 1)).toBe(1);
    expect(nextZoom(0.8, -1)).toBe(0.75);
    expect(nextZoom(zoomSteps.at(-1)!, 1)).toBe(zoomSteps.at(-1));
    expect(nextZoom(zoomSteps[0]!, -1)).toBe(zoomSteps[0]);
  });
  it("never enlarges below the ladder when fit produced a smaller scale", () => {
    expect(nextZoom(0.03, -1)).toBe(0.03);
    expect(nextZoom(0.03, 1)).toBe(0.1);
  });
  it("shrinks oversized images to fit and leaves smaller ones alone", () => {
    expect(fitScale({ width: 800, height: 400 }, { width: 400, height: 400 })).toBe(0.5);
    expect(fitScale({ width: 800, height: 400 }, { width: 800, height: 100 })).toBe(0.25);
    expect(fitScale({ width: 16, height: 16 }, { width: 800, height: 400 })).toBe(1);
  });
  it("falls back to 1:1 before either size is measured", () => {
    expect(fitScale({ width: 0, height: 0 }, { width: 400, height: 400 })).toBe(1);
    expect(fitScale({ width: 800, height: 400 }, { width: 0, height: 0 })).toBe(1);
  });
  it("formats sizes and zoom levels for the toolbar", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatZoom(1)).toBe("100%");
    expect(formatZoom(0.075)).toBe("7.5%");
  });
});
