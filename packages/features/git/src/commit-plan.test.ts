import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CommitPlanDialog } from "./commit-plan.js";

const plan = [{ message: "Rename", files: [{ path: "new.ts", originalPath: "old.ts" }] }];
const render = (partial: string[]) =>
  renderToStaticMarkup(createElement(CommitPlanDialog, { plan, partial, run: async () => {}, onClose: () => {} }));

describe("commit plan dialog", () => {
  it("shows both sides of a rename", () => {
    expect(render([])).toContain("old.ts → new.ts");
  });
  it("warns when partially staged files left out of the plan will be fully staged", () => {
    expect(render(["keep.txt"])).toContain("1 partially staged files stay out of these commits.");
    expect(render(["new.ts"])).not.toContain("partially staged");
    expect(render([])).not.toContain("partially staged");
  });
});
