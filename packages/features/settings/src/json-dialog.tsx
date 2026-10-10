import { useState } from "react";
import type { Kernel } from "@oxbit/sdk";
import type { WorkbenchController } from "@oxbit/workbench";
import { Dialog, translate as tr } from "@oxbit/ui";
import { applyLayer, readLayer } from "./json-layer.js";

export function EditJsonDialog({ kernel, workbench, scope, language, onClose }: {
  kernel: Kernel; workbench: WorkbenchController; scope: "user" | "workspace"; language?: string; onClose(): void;
}) {
  const [original] = useState(() => readLayer(kernel, scope, language));
  const [text, setText] = useState(() => JSON.stringify(original, null, 2));
  const [error, setError] = useState("");
  const apply = () => {
    try {
      const next: unknown = JSON.parse(text);
      if (!next || typeof next !== "object" || Array.isArray(next)) throw new Error(tr("Settings JSON must be an object."));
      applyLayer(kernel, original, next as Record<string, unknown>, scope, language);
      workbench.touch();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <Dialog title={tr("Edit as JSON")} className="settings-json-dialog" onClose={onClose} initialFocus="textarea">
      <p className="dialog-intro">
        {scope === "user" ? tr("User") : tr("Workspace")}{language ? ` · ${language}` : ""}
      </p>
      <textarea aria-label={tr("Settings JSON")} aria-invalid={!!error} value={text} rows={14} spellCheck={false}
        autoCapitalize="off" autoCorrect="off" onChange={event => { setText(event.target.value); setError(""); }} />
      {error && <p role="alert" className="error-text">{error}</p>}
      <div className="dialog-actions">
        <button className="button" onClick={onClose}>{tr("Cancel")}</button>
        <button className="button primary" onClick={apply}>{tr("Apply")}</button>
      </div>
    </Dialog>
  );
}
