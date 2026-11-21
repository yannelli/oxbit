import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Kernel } from "@oxbit/sdk";
import type { WorkbenchController } from "@oxbit/workbench";
import { Dialog, displayShortcut, translate as tr } from "@oxbit/ui";
import { applyLayer, readLayer } from "./json-layer.js";
import { indentText, jsonErrorLocation, settingWarnings } from "./json-tools.js";

function parseObject(text: string): Record<string, unknown> {
  const next: unknown = JSON.parse(text);
  if (!next || typeof next !== "object" || Array.isArray(next)) throw new TypeError(tr("Settings JSON must be an object."));
  return next as Record<string, unknown>;
}

export function EditJsonDialog({ kernel, workbench, scope, language, onClose }: {
  kernel: Kernel; workbench: WorkbenchController; scope: "user" | "workspace"; language?: string; onClose(): void;
}) {
  const [original] = useState(() => readLayer(kernel, scope, language));
  const [initial] = useState(() => JSON.stringify(original, null, 2));
  const [text, setText] = useState(initial);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const keep = useRef<HTMLButtonElement>(null);
  const selection = useRef<[number, number] | undefined>(undefined);
  const ids = useId();
  const warnings = useMemo(() => {
    try { return settingWarnings(kernel.configuration.list(), parseObject(text)); } catch { return []; }
  }, [kernel, text]);
  const apply = () => {
    let next: Record<string, unknown>;
    try {
      next = parseObject(text);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const at = e instanceof SyntaxError ? jsonErrorLocation(text, message) : undefined;
      setError(at ? tr("Line {0}, column {1}: {2}", { "0": at.line, "1": at.column, "2": at.message }) : message);
      if (at) { area.current?.focus(); area.current?.setSelectionRange(at.offset, at.offset); }
      return;
    }
    try {
      applyLayer(kernel, original, next, scope, language);
      workbench.touch();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const requestClose = () => {
    if (confirming) { setConfirming(false); area.current?.focus(); }
    else if (text !== initial) setConfirming(true);
    else onClose();
  };
  const applyRef = useRef(apply);
  applyRef.current = apply;
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    // A native listener runs before the Dialog's focus trap, so Tab can indent here.
    const key = (event: KeyboardEvent) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); applyRef.current(); return; }
      if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      event.stopPropagation();
      const next = indentText(el.value, el.selectionStart, el.selectionEnd, event.shiftKey);
      selection.current = [next.start, next.end];
      setText(next.value);
      setError("");
    };
    el.addEventListener("keydown", key);
    return () => el.removeEventListener("keydown", key);
  }, []);
  useLayoutEffect(() => {
    const range = selection.current;
    selection.current = undefined;
    if (range) area.current?.setSelectionRange(range[0], range[1]);
  }, [text]);
  useEffect(() => { if (confirming) keep.current?.focus(); }, [confirming]);
  const described = [`${ids}-hint`, error && `${ids}-error`, warnings.length && `${ids}-warnings`].filter(Boolean).join(" ");
  return (
    <Dialog title={tr("Edit as JSON")} className="settings-json-dialog" onClose={requestClose} initialFocus="textarea">
      <p className="dialog-intro">
        {scope === "user" ? tr("User") : tr("Workspace")}{language ? ` · ${language}` : ""}
      </p>
      <textarea ref={area} aria-label={tr("Settings JSON")} aria-invalid={!!error} aria-describedby={described} value={text} rows={14}
        spellCheck={false} autoCapitalize="off" autoCorrect="off" onChange={event => { setText(event.target.value); setError(""); }} />
      <p id={`${ids}-hint`} className="settings-json-hint">
        {tr("Tab indents, Shift-Tab outdents, {0} applies.", { "0": displayShortcut("Mod+Enter") })}
      </p>
      {error && <p id={`${ids}-error`} role="alert" className="error-text">{error}</p>}
      {warnings.length > 0 && (
        <ul id={`${ids}-warnings`} className="settings-json-warnings" aria-label={tr("Warnings")}>
          {warnings.map(item => <li key={item} className="warning-text">{item}</li>)}
        </ul>
      )}
      {confirming ? (
        <div className="dialog-actions settings-json-confirm" role="group" aria-labelledby={`${ids}-confirm`}>
          <p id={`${ids}-confirm`}>{tr("Discard your changes?")}</p>
          <button ref={keep} className="button" onClick={requestClose}>{tr("Keep editing")}</button>
          <button className="button danger" onClick={onClose}>{tr("Discard")}</button>
        </div>
      ) : (
        <div className="dialog-actions">
          <button className="button" onClick={onClose}>{tr("Cancel")}</button>
          <button className="button primary" onClick={apply}>{tr("Apply")}</button>
        </div>
      )}
    </Dialog>
  );
}
