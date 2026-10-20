import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PairingQr, formatCountdown } from "./remote-access.js";

describe("remote access pairing", () => {
  it("formats the time left on a pairing link", () => {
    expect(formatCountdown(120_000)).toBe("2:00");
    expect(formatCountdown(61_001)).toBe("1:02");
    expect(formatCountdown(9_000)).toBe("0:09");
    expect(formatCountdown(-5)).toBe("0:00");
  });
  it("renders a QR code only when an encoder is present", () => {
    const link = "https://oxbit.dev/c#o=abc";
    expect(renderToStaticMarkup(createElement(PairingQr, { link }))).toBe("");
    const markup = renderToStaticMarkup(createElement(PairingQr, { link, encode: () => [[true, false], [false, true]] }));
    expect(markup).toContain('viewBox="0 0 10 10"');
    expect(markup).toContain("M4 4h1v1h-1zM5 5h1v1h-1z");
  });
});
