import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { hasNextSnippetField, nextSnippetField, prevSnippetField } from "@codemirror/autocomplete";
import { completionItems, completionTransactions, snippetTemplate } from "./completion.js";
import { parameterRange } from "./popups.js";
describe("LSP completion application", () => {
  it("inherits list defaults without overwriting item edits or provider data", () => {
    const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } };
    const values = completionItems({ itemDefaults: { editRange: { insert: range, replace: range }, insertTextFormat: 2, data: { provider: 1 }, commitCharacters: ["."] }, items: [{ label: "z", preselect: true, textEditText: "z($1)" }, { label: "a", data: { provider: 2 } }] });
    expect(values[0]).toMatchObject({ label: "z", insertTextFormat: 2, textEdit: { insert: range, newText: "z($1)" }, data: { provider: 1 } });
    expect(values[1].data).toEqual({ provider: 2 });
  });
  it("preserves import edits, Unicode offsets and editable snippet fields", () => {
    const state = EditorState.create({ doc: "// 😀\ncall", selection: { anchor: 10 } });
    const transactions = completionTransactions(state, { label: "call", insertTextFormat: 2, insertText: "call(${1:value}, ${2:other})$0", additionalTextEdits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "import x;\n" }] }, { label: "call" }, 6, 10);
    let current = transactions.at(-1)!.state;
    expect(current.doc.toString()).toBe("import x;\n// 😀\ncall(value, other)");
    expect(current.sliceDoc(current.selection.main.from, current.selection.main.to)).toBe("value");
    expect(hasNextSnippetField(current)).toBe(true);
    const editor = { get state() { return current; }, dispatch: (transaction: any) => { current = transaction.state; } };
    expect(nextSnippetField(editor as any)).toBe(true);
    expect(current.sliceDoc(current.selection.main.from, current.selection.main.to)).toBe("other");
    expect(prevSnippetField(editor as any)).toBe(true);
    expect(current.sliceDoc(current.selection.main.from, current.selection.main.to)).toBe("value");
  });
  it("rejects overlapping or read-only edits before applying anything", () => {
    const item = { label: "x", additionalTextEdits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } }, newText: "no" }] };
    expect(() => completionTransactions(EditorState.create({ doc: "abc" }), item, { label: "x" }, 1, 3)).toThrow("overlapping");
    expect(() => completionTransactions(EditorState.create({ doc: "abc", extensions: EditorState.readOnly.of(true) }), { label: "x" }, { label: "x" }, 1, 3)).toThrow("read-only");
  });
  it("starts a snippet transaction from the live editor state when there are no import edits", () => {
    const state = EditorState.create({ doc: "call", selection: { anchor: 4 } });
    const transactions = completionTransactions(state, { label: "call", insertTextFormat: 2, insertText: "call(${1:value})$0" }, { label: "call" }, 0, 4);
    expect(transactions[0].startState).toBe(state);
    expect(transactions.at(-1)!.state.doc.toString()).toBe("call(value)");
  });
  it("normalizes short tab stops and choices without stripping placeholders", () => {
    expect(snippetTemplate("${1|one,two|}($2)$0")).toBe("${1:one}(${2})${0}");
  });
  it("validates active parameter metadata in UTF-16 units", () => {
    expect(parameterRange({ label: "f(😀, value)", parameters: [{ label: [6, 11] }] }, 0)).toEqual([6, 11]);
    expect(parameterRange({ label: "f(value)", parameters: [{ label: "value" }] }, 0)).toEqual([2, 7]);
    expect(parameterRange({ label: "f()", parameters: [{ label: [2, 40] }] }, 0)).toBeUndefined();
  });
});
