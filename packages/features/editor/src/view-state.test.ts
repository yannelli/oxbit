import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { codeFolding, foldEffect } from "@codemirror/language";
import {
  restoredSelection,
  savedFolds,
  detectedIndentation,
} from "./view-state.js";
describe("independent editor view recovery", () => {
  it("clamps recovered multicursors after the shared document shrinks", () => {
    const selection = restoredSelection(
      {
        anchor: 50,
        head: 100,
        scrollTop: 0,
        selection: {
          ranges: [
            { anchor: 0, head: 1 },
            { anchor: 20, head: 90 },
          ],
          main: 1,
        },
      },
      5,
    )!;
    expect(selection.ranges.map((range) => [range.anchor, range.head])).toEqual(
      [
        [0, 1],
        [5, 5],
      ],
    );
    expect(selection.main.head).toBe(5);
  });
  it("records collapsed ranges independently of the text buffer", () => {
    let state = EditorState.create({
      doc: "one\ntwo\nthree\n",
      extensions: [codeFolding()],
    });
    state = state.update({ effects: foldEffect.of({ from: 3, to: 13 }) }).state;
    expect(savedFolds(state)).toEqual([{ from: 3, to: 13 }]);
  });
  it("detects tabs and indentation from a bounded prefix", () => {
    expect(detectedIndentation("fn() {\n    return 1;\n}", 2, true)).toEqual({
      size: 4,
      spaces: true,
    });
    expect(detectedIndentation("\treturn 1", 4, true)).toEqual({
      size: 4,
      spaces: false,
    });
    expect(detectedIndentation("plain text", 2, true)).toEqual({
      size: 2,
      spaces: true,
    });
  });
});
