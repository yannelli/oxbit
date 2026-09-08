import React, { useEffect, useRef, useState } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { javascript } from "@codemirror/lang-javascript";
import type { ExternalDocument } from "@oxbit/sdk";
import type { LanguageService } from "./index.js";
export interface NavigationTarget { uri: string; range: { start: { line: number; character: number }; end: { line: number; character: number } }; name?: string }
export function navigationTargets(value: any): NavigationTarget[] {
  const result: NavigationTarget[] = [], known = new Set<string>();
  for (const item of Array.isArray(value) ? value : value ? [value] : []) {
    const uri = item.uri ?? item.targetUri ?? item.location?.uri, range = item.targetSelectionRange ?? item.selectionRange ?? item.range ?? item.location?.range;
    if (typeof uri !== "string" || !range || ![range.start, range.end].every(pos => pos && Number.isInteger(pos.line) && pos.line >= 0 && Number.isInteger(pos.character) && pos.character >= 0) || range.end.line < range.start.line || range.end.line === range.start.line && range.end.character < range.start.character) continue;
    const key = JSON.stringify([uri, range]);
    if (!known.has(key)) { known.add(key); result.push({ uri, range, name: item.name }); }
  }
  return result;
}
const externalSyntax = HighlightStyle.define([
  [tags.keyword, "keyword"], [tags.string, "string"], [tags.number, "number"], [tags.comment, "comment"],
  [tags.typeName, "type"], [tags.function(tags.variableName), "function"], [tags.propertyName, "property"], [tags.variableName, "variable"], [tags.punctuation, "punct"], [tags.operator, "operator"],
].map(([tag, token]) => ({ tag: tag as import("@lezer/highlight").Tag, color: `var(--tok-${token})`, backgroundColor: `var(--tok-${token}-background)`, fontWeight: `var(--tok-${token}-weight)`, fontStyle: `var(--tok-${token}-style)`, textDecoration: `var(--tok-${token}-decoration)` })));
export function ExternalSource({ source, line = 1, col = 1 }: { source: ExternalDocument; line?: number; col?: number }) {
  const mount = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const state = EditorState.create({ doc: source.text, extensions: [EditorState.readOnly.of(true), EditorView.editable.of(false), EditorView.contentAttributes.of({ tabindex: "0" }), lineNumbers(), syntaxHighlighting(externalSyntax), ...( /\.[cm]?[jt]sx?$/.test(source.name) ? [javascript({ typescript: /\.[cm]?tsx?$/.test(source.name), jsx: /x$/.test(source.name) })] : []), EditorView.theme({ "&": { height: "100%", backgroundColor: "var(--bg-editor)", color: "var(--tok-text)", fontSize: "var(--font-editor-font-size)" }, ".cm-scroller": { overflow: "auto", fontFamily: "var(--font-editor-font-family)", lineHeight: "var(--font-editor-line-height)" }, ".cm-content": { padding: "6px 0" }, ".cm-line": { padding: "0 8px" }, ".cm-gutters": { backgroundColor: "var(--editor-gutter-background)", color: "var(--editor-gutter-foreground)", border: "none" }, ".cm-lineNumbers .cm-gutterElement": { minWidth: "35px", paddingRight: "8px" } })] });
    const view = new EditorView({ state, parent: mount.current! });
    const target = view.state.doc.line(Math.min(view.state.doc.lines, Math.max(1, line))), anchor = Math.min(target.to, target.from + Math.max(0, col - 1));
    view.dispatch({ selection: { anchor }, effects: EditorView.scrollIntoView(anchor, { y: "center" }) });
    return () => view.destroy();
  }, [source, line, col]);
  return <div style={{ height: "100%", display: "flex", flexDirection: "column" }}><div style={{ padding: 8 }}>External source · Read-only · {source.name}</div><div ref={mount} style={{ flex: 1, minHeight: 0 }} aria-label={`Read-only ${source.name}`} /></div>;
}
export function Hierarchy({ service, items, method }: { service: LanguageService; items: any[]; method: string }) {
  return <ul aria-label="Language hierarchy">{items.map((item, index) => <HierarchyItem key={`${item.uri}:${item.name}:${index}`} service={service} item={item} method={method} />)}</ul>;
}
function HierarchyItem({ service, item, method }: { service: LanguageService; item: any; method: string }) {
  const [children, setChildren] = useState<any[] | null>(null), [expanded, setExpanded] = useState(false), [error, setError] = useState("");
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const expand = async () => {
    if (expanded) { pending.current?.abort(); setExpanded(false); return; }
    setExpanded(true); if (children) return;
    pending.current?.abort(); const controller = new AbortController(); pending.current = controller;
    try { const result = await service.request(method, { item }, controller.signal); if (!controller.signal.aborted) setChildren((result ?? []).map((entry: any) => entry.from ?? entry.to ?? entry)); }
    catch (error) { if (!controller.signal.aborted) setError(String(error)); }
  };
  return <li><button aria-label={`Expand ${item.name}`} aria-expanded={expanded} onClick={() => void expand()}>{expanded ? "▾" : "▸"}</button><button onClick={() => void service.navigate(navigationTargets(item)[0]).catch(error => setError(String(error)))}>{item.name}</button>{error && <span role="status">{error}</span>}{expanded && (children ? <Hierarchy service={service} items={children} method={method} /> : <span>{error ? "" : "Loading…"}</span>)}</li>;
}
export function WorkspaceSymbols({ service }: { service: LanguageService }) {
  const [query, setQuery] = useState(""), [results, setResults] = useState<{ service: LanguageService; target: NavigationTarget }[]>([]), [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => { void service.workspaceSymbols(query, controller.signal).then(values => { if (!controller.signal.aborted) { setResults(values); setError(""); } }).catch(error => { if (!controller.signal.aborted) setError(String(error)); }); }, 150);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, service]);
  return <div style={{ padding: 12 }}><input aria-label="Search workspace symbols" autoFocus value={query} onChange={event => setQuery(event.target.value)} /><div role="status">{error || `${results.length} symbols`}</div><ul>{results.map(({ target, service: owner }, index) => <li key={index}><button onClick={() => void owner.navigate(target).catch(error => setError(String(error)))}>{target.name ?? target.uri}</button></li>)}</ul></div>;
}
