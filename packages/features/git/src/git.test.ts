import { describe, expect, it } from "vitest";
import { resolveConflict } from "./index.js";
describe("conflict resolution", () => {
  const conflict =
    "before\n<<<<<<< HEAD\nlocal\n=======\nremote\n>>>>>>> other\nafter\n";
  it("preserves surrounding content for each choice", () => {
    expect(resolveConflict(conflict, "current")).toBe("before\nlocal\nafter\n");
    expect(resolveConflict(conflict, "incoming")).toBe(
      "before\nremote\nafter\n",
    );
    expect(resolveConflict(conflict, "both")).toBe(
      "before\nlocal\nremote\nafter\n",
    );
  });
});

describe('buffer comparison',()=>{
  it('shows deleted and added lines while keeping matched lines',async()=>{const {unifiedDiff}=await import('./index.js');const diff=unifiedDiff('head\nold\nkept\nend','head\nnew\nkept\nlast\nend');expect(diff).toContain('-old');expect(diff).toContain('+new');expect(diff).toContain(' kept');expect(diff).toContain('+last');});
});
