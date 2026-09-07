import { useCallback } from "react";
import { Dialog, Icon, OxbitLogo, translate as tr } from "@oxbit/ui";
import { SDK_VERSION } from "@oxbit/sdk";
import type { WorkbenchController } from "./controller.js";

export function AboutDialog({ workbench }: { workbench: WorkbenchController }) {
  const close = useCallback(
    () => workbench.set({ aboutOpen: false }),
    [workbench],
  );
  return (
    <Dialog title={tr("About Oxbit")} className="about-dialog" onClose={close}>
      <div className="about-identity">
        <OxbitLogo />
        <p>{tr("An extensible code workspace.")}</p>
      </div>
      <div className="about-links">
        <a
          href="https://github.com/yannelli/oxbit"
          target="_blank"
          rel="noreferrer"
        >
          <Icon name="git" />
          {tr("Source code")}
          <Icon name="chevR" size={12} />
        </a>
        <a href="/LICENSE.txt" target="_blank" rel="noreferrer">
          <Icon name="files" />
          {tr("MIT License")}
          <Icon name="chevR" size={12} />
        </a>
      </div>
      <details className="about-credits">
        <summary>{tr("Built with")}</summary>
        <dl>
          <div>
            <dt>{tr("Interface")}</dt>
            <dd>React</dd>
          </div>
          <div>
            <dt>{tr("Editor")}</dt>
            <dd>CodeMirror</dd>
          </div>
          <div>
            <dt>{tr("Collaboration")}</dt>
            <dd>Yjs</dd>
          </div>
          <div>
            <dt>{tr("Extension SDK")}</dt>
            <dd>{SDK_VERSION}</dd>
          </div>
        </dl>
      </details>
      <footer className="about-footer">
        <p>
          {tr("Created by")}{" "}
          <a
            href="https://github.com/yannelli"
            target="_blank"
            rel="noreferrer"
          >
            Ryan Yannelli
          </a>
        </p>
        <button type="button" className="button" onClick={close}>
          {tr("Done")}
        </button>
      </footer>
    </Dialog>
  );
}
