import { describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { LanguageOverlays, semanticRanges, tokenDelta } from "./overlays.js";
import { navigationTargets } from "./navigation.js";
const legend = { tokenTypes: ["variable", "function", "unknown"], tokenModifiers: ["readonly", "deprecated"] };
describe("semantic token validation", () => {
  it("maps UTF-16 tokens and leaves unknown names to syntax highlighting", () => {
    const ranges = semanticRanges("😀foo\r\nbar", [0, 2, 3, 0, 1, 1, 0, 3, 2, 0], legend);
    expect(ranges.map(range => [range.from, range.to])).toEqual([[2, 5]]);
  });
  it.each([[0, 0, 1], [0, 0, 0, 0, 0], [0, 0, 10, 0, 0], [0, 0, 2, 0, 0, 0, 1, 2, 0, 0], [0, 0, 1, 4, 0], [0, 0, 1, 0, 8], [-1, 0, 1, 0, 0]])("rejects malformed streams %j", (...data) => {
    expect(() => semanticRanges("abc", data, legend)).toThrow();
  });
  it("applies edits in original-array coordinates and rejects overlap", () => {
    expect(tokenDelta([0, 0, 3, 0, 0, 1, 0, 2, 1, 0], [{ start: 3, deleteCount: 1, data: [1] }, { start: 7, deleteCount: 1, data: [3] }])).toEqual([0, 0, 3, 1, 0, 1, 0, 3, 1, 0]);
    expect(() => tokenDelta([1, 2, 3], [{ start: 0, deleteCount: 2 }, { start: 1, deleteCount: 1 }])).toThrow();
    expect(() => tokenDelta([], [{ start: 1, deleteCount: 0 }])).toThrow();
  });
});
describe("navigation targets", () => {
  it("normalizes LocationLink and locations and removes duplicates", () => {
    const range = { start: { line: 1, character: 2 }, end: { line: 1, character: 4 } };
    expect(navigationTargets([{ uri: "file:///a.ts", range }, { targetUri: "file:///a.ts", targetSelectionRange: range }, { name: "value", location: { uri: "file:///b.ts", range } }, { uri: "file:///bad", range: { start: { line: -1, character: 0 }, end: range.end } }])).toEqual([{ uri: "file:///a.ts", range }, { uri: "file:///b.ts", range, name: "value" }]);
  });
});

it("limits large documents to viewport semantic requests unless explicitly enabled", async () => {
  const text = "x".repeat(1024 * 1024 + 1);
  const request = vi.fn(async (method: string) => method === "textDocument/inlayHint" ? [] : { data: [] });
  let optIn = false;
  const overlay = new LanguageOverlays({ ready: () => true, uri: () => "file:///workspace/large.ts", capabilities: () => ({ semanticTokensProvider: { legend, full: true, range: true }, inlayHintProvider: true }), enabled: (setting: string) => setting !== "editor.largeFileIntelligence" || optIn, request } as any);
  (overlay as any).views.add({ state: EditorState.create({ doc: text }), viewport: { from: 0, to: 40 }, dispatch: vi.fn() });
  await (overlay as any).fetch();
  expect(request.mock.calls.map(call => call[0])).toEqual(["textDocument/semanticTokens/range"]);
  request.mockClear(); optIn = true; await (overlay as any).fetch();
  expect(request.mock.calls.map(call => call[0])).toEqual(["textDocument/semanticTokens/full", "textDocument/inlayHint"]);
  overlay.dispose();
});
