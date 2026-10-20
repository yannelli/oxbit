import React, { useId } from "react";
import { translate as tr } from "@oxbit/ui";
import type { PreviewResourceTrust } from "./policy.js";

/** `scripts` is set by previews that can run JavaScript; running scripts loads every resource. */
export function PreviewResourceControl({ trust, onChange, scripts }: {
  trust: PreviewResourceTrust;
  onChange(trust: PreviewResourceTrust): void;
  scripts?: boolean;
}) {
  const id = useId();
  const hint = scripts ? tr("JavaScript is on, so this preview loads external resources.")
    : trust === "external" ? (scripts === false
      ? tr("External images, styles, fonts, and media can contact their servers.")
      : tr("External images, styles, fonts, and media can contact their servers. JavaScript is disabled."))
    : tr("External resources are blocked. Allow them if you trust this document.");
  return <div className="preview-resource-control">
    <label htmlFor={id}>{tr("External resources")}</label>
    <select id={id} value={scripts ? "external" : trust} disabled={scripts} aria-describedby={`${id}-hint`}
      onChange={event => onChange(event.target.value === "external" ? "external" : "local")}>
      <option value="local">{tr("Local files only")}</option>
      <option value="external">{tr("Allow for this preview")}</option>
    </select>
    <p id={`${id}-hint`}>{hint}</p>
  </div>;
}

export function PreviewScriptControl({ running, onChange }: { running: boolean; onChange(running: boolean): void }) {
  const id = useId();
  return <div className="preview-resource-control">
    <label htmlFor={id}>{tr("JavaScript")}</label>
    <select id={id} value={running ? "on" : "off"} aria-describedby={`${id}-hint`}
      onChange={event => onChange(event.target.value === "on")}>
      <option value="off">{tr("Off")}</option>
      <option value="on">{tr("Run for this preview")}</option>
    </select>
    <p id={`${id}-hint`}>{running
      ? tr("Scripts run in an isolated frame. They can load content from the internet and send data to it.")
      : tr("Scripts are off. Turn them on if you trust this page.")}</p>
  </div>;
}
