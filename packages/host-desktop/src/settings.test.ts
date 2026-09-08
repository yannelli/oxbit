import { describe, expect, it } from "vitest";
import { profileChanges } from "./settings.js";
describe("desktop user settings patches", () => {
  it("writes only locally changed keys so another project's settings survive", () => {
    const before = {
      user: { theme: "dark", font: 14 },
      userLanguages: { typescript: { indent: 2 } },
    };
    const after = {
      user: { theme: "light", font: 14 },
      userLanguages: { typescript: { indent: 4 } },
    };
    expect(profileChanges(before, after)).toEqual([
      { path: ["user", "theme"], value: "light" },
      { path: ["userLanguages", "typescript", "indent"], value: 4 },
    ]);
  });
  it("represents resets as explicit deletions and leaves unchanged profiles alone", () => {
    const profile = { user: { a: 1 }, userLanguages: {} };
    expect(profileChanges(profile, profile)).toEqual([]);
    expect(profileChanges(profile, { user: {}, userLanguages: {} })).toEqual([
      { path: ["user", "a"], value: undefined },
    ]);
  });
});
