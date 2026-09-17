import React, { useId } from "react";
import { translate as tr } from "@oxbit/ui";
import type { PreviewResourceTrust } from "./policy.js";

export function PreviewResourceControl({ trust, onChange }: {
  trust: PreviewResourceTrust;
  onChange(trust: PreviewResourceTrust): void;
}) {
  const id = useId();
  return <div className="preview-resource-control">
    <label htmlFor={id}>{tr("External resources")}</label>
    <select id={id} value={trust} aria-describedby={`${id}-hint`}
      onChange={event => onChange(event.target.value === "external" ? "external" : "local")}>
      <option value="local">{tr("Local files only")}</option>
      <option value="external">{tr("Allow for this preview")}</option>
    </select>
    <p id={`${id}-hint`}>{trust === "external"
      ? tr("External images, styles, fonts, and media can contact their servers. JavaScript is disabled.")
      : tr("External resources are blocked. Allow them if you trust this document.")}</p>
  </div>;
}
