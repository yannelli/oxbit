import { describe, expect, it } from "vitest";
import { EditorState, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { acceptSuggestion, acceptWord, currentSuggestion, dismissSuggestion, setSuggestion, suggestionField } from "./ghost.js";

function fakeView(doc: string, cursor = doc.length) {
  const view = {
    state: EditorState.create({ doc, selection: { anchor: cursor }, extensions: [suggestionField] }),
    dispatch(spec: TransactionSpec) { view.state = view.state.update(spec).state; },
  };
  return view as typeof view & EditorView;
}
const suggest = (view: EditorView, text: string, from = view.state.selection.main.head) =>
  view.dispatch({ effects: setSuggestion.of({ from, text }) });

describe("ghost text suggestions", () => {
  it("inserts the whole suggestion on accept and moves the cursor after it", () => {
    const view = fakeView("const x = ");
    suggest(view, "compute(1, 2);");
    expect(acceptSuggestion(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("const x = compute(1, 2);");
    expect(view.state.selection.main.head).toBe(view.state.doc.length);
    expect(currentSuggestion(view.state)).toBeNull();
  });

  it("accepts one word at a time and keeps the rest", () => {
    const view = fakeView("return ");
    suggest(view, "items.length > 0");
    acceptWord(view);
    expect(view.state.doc.toString()).toBe("return items");
    expect(currentSuggestion(view.state)).toEqual({ from: 12, text: ".length > 0" });
    acceptWord(view);
    acceptWord(view);
    expect(view.state.doc.toString()).toBe("return items.length");
  });

  it("keeps the rest of the suggestion while the user types it", () => {
    const view = fakeView("if (");
    suggest(view, "ready) {");
    view.dispatch({ changes: { from: 4, insert: "rea" }, selection: { anchor: 7 }, userEvent: "input.type" });
    expect(currentSuggestion(view.state)).toEqual({ from: 7, text: "dy) {" });
  });

  it("clears on a different keystroke, a cursor move, or dismiss", () => {
    const typed = fakeView("if (");
    suggest(typed, "ready) {");
    typed.dispatch({ changes: { from: 4, insert: "x" }, selection: { anchor: 5 }, userEvent: "input.type" });
    expect(currentSuggestion(typed.state)).toBeNull();

    const moved = fakeView("ab");
    suggest(moved, "cd");
    moved.dispatch({ selection: { anchor: 0 } });
    expect(currentSuggestion(moved.state)).toBeNull();

    const dismissed = fakeView("ab");
    suggest(dismissed, "cd");
    expect(dismissSuggestion(dismissed)).toBe(true);
    expect(currentSuggestion(dismissed.state)).toBeNull();
  });

  it("leaves Tab and Escape to other handlers when nothing is suggested", () => {
    const view = fakeView("x");
    expect(acceptSuggestion(view)).toBe(false);
    expect(acceptWord(view)).toBe(false);
    expect(dismissSuggestion(view)).toBe(false);
  });
});
