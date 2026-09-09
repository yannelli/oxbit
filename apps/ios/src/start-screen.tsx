import { Icon, OxbitMark } from "@oxbit/ui";
import type { RecentWorkspace } from "@oxbit/host-ios";
import { DOCUMENTS_ID } from "./workspaces.js";

export function StartScreen({
  recents,
  busy,
  error,
  current,
  onOpenDocuments,
  onPick,
  onOpenRecent,
  onForget,
  onDismiss,
}: {
  recents: RecentWorkspace[];
  busy?: string;
  error?: string;
  current?: string;
  onOpenDocuments: () => void;
  onPick: () => void;
  onOpenRecent: (recent: RecentWorkspace) => void;
  onForget: (recent: RecentWorkspace) => void;
  onDismiss?: () => void;
}) {
  const folders = recents.filter((recent) => recent.kind === "bookmark");
  return (
    <div className="ios-start" role="dialog" aria-label="Workspaces">
      <header className="ios-start-header">
        <span className="ios-start-brand" role="img" aria-label="Oxbit">
          <OxbitMark decorative />
        </span>
        <h1>Oxbit</h1>
        {onDismiss && (
          <button className="text-button" onClick={onDismiss} disabled={!!busy}>
            Done
          </button>
        )}
      </header>
      {error && (
        <p className="ios-start-error" role="alert">
          {error}
        </p>
      )}
      <section aria-label="On this device">
        <h2>On this device</h2>
        <button className="ios-workspace" onClick={onOpenDocuments} disabled={!!busy} aria-current={current === DOCUMENTS_ID ? "true" : undefined}>
          <Icon name="folder" />
          <span>
            Oxbit
            <small>Files app › On My iPhone or iPad</small>
          </span>
        </button>
      </section>
      <section aria-label="Folders">
        <h2>Folders</h2>
        {folders.map((recent) => (
          <div className="ios-workspace-row" key={recent.id}>
            <button className="ios-workspace" onClick={() => onOpenRecent(recent)} disabled={!!busy} aria-current={current === recent.id ? "true" : undefined}>
              <Icon name="folder" />
              <span>
                {recent.name}
                <small>{new Date(recent.lastOpened).toLocaleString()}</small>
              </span>
            </button>
            <button className="icon-button" aria-label={`Forget ${recent.name}`} onClick={() => onForget(recent)} disabled={!!busy}>
              <Icon name="close" size={14} />
            </button>
          </div>
        ))}
        <button className="button primary ios-open-folder" onClick={onPick} disabled={!!busy}>
          <Icon name="folder" />
          Open Folder…
        </button>
        <p className="muted">Choose any folder from the Files app. Oxbit keeps access after you relaunch.</p>
      </section>
      {busy && (
        <p className="muted" role="status">
          {busy}
        </p>
      )}
    </div>
  );
}
