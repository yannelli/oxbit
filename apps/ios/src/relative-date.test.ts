import { describe, expect, it } from "vitest";
import { relativeDate } from "./relative-date.js";

const now = new Date(2026, 9, 19, 15, 0).getTime();

describe("relativeDate", () => {
  it("shows today with the time", () => {
    expect(relativeDate(new Date(2026, 9, 19, 12, 41).getTime(), now)).toMatch(/^Today, 12:41\sPM$/);
  });

  it("shows yesterday across midnight", () => {
    expect(relativeDate(new Date(2026, 9, 18, 23, 59).getTime(), new Date(2026, 9, 19, 0, 1).getTime())).toBe("Yesterday");
  });

  it("shows a short date this year and adds the year otherwise", () => {
    expect(relativeDate(new Date(2026, 9, 12, 9).getTime(), now)).toBe("Oct 12");
    expect(relativeDate(new Date(2025, 9, 12, 9).getTime(), now)).toBe("Oct 12, 2025");
  });

  it("follows the locale", () => {
    expect(relativeDate(new Date(2026, 9, 18, 9).getTime(), now, "de")).toBe("Gestern");
  });
});
