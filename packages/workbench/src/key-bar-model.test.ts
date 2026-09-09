import { describe, expect, it } from "vitest";
import { KEY_BAR_ITEMS, KeyBarModel } from "./key-bar-model";

describe("KeyBarModel", () => {
  it("applies the sticky modifier to the next key only", () => {
    const model = new KeyBarModel();
    const left = KEY_BAR_ITEMS.find((item) => item.id === "left")!.action;
    if (left.kind !== "key") throw new Error("left is a key");
    expect(model.init(left).metaKey).toBe(false);
    expect(model.toggleSticky()).toBe(true);
    expect(model.init(left)).toMatchObject({ key: "ArrowLeft", metaKey: true, shiftKey: false });
    expect(model.sticky).toBe(false);
    expect(model.init(left).metaKey).toBe(false);
  });
  it("keeps built-in modifiers and clears a pending sticky state", () => {
    const model = new KeyBarModel();
    const redo = KEY_BAR_ITEMS.find((item) => item.id === "redo")!.action;
    if (redo.kind !== "key") throw new Error("redo is a key");
    model.toggleSticky();
    expect(model.init(redo)).toMatchObject({ key: "z", metaKey: true, shiftKey: true });
    expect(model.sticky).toBe(false);
    expect(model.toggleSticky()).toBe(true);
    expect(model.toggleSticky()).toBe(false);
  });
  it("lists unique ids", () => {
    expect(new Set(KEY_BAR_ITEMS.map((item) => item.id)).size).toBe(KEY_BAR_ITEMS.length);
  });
});
