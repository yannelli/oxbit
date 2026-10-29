import { useState } from "react";
import { Dialog, Icon, OxbitMark, getLocale, translate as tr } from "@oxbit/ui";
import type { RecentWorkspace } from "@oxbit/host-ios";
import { DOCUMENTS_ID } from "./workspaces.js";
import { relativeDate } from "./relative-date.js";
import { WorkspaceRow } from "./workspace-row.js";

const ICONS: Record<RecentWorkspace["kind"], string> = {
  documents: "folder",
  bookmark: "folder",
  runtime: "cloud",
  ssh: "terminal",
  sshRuntime: "terminal",
};

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
  onConnect,
  onGitSettings,
  onClone,
  onSsh,
  onSshRuntime,
  onSshSettings,
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
  onConnect: () => void;
  onGitSettings: () => void;
  onClone: () => void;
  onSsh: (recent?: RecentWorkspace) => void;
  onSshRuntime: (recent?: RecentWorkspace) => void;
  onSshSettings: () => void;
}) {
  const folders = recents.filter((recent) => recent.kind === "bookmark" || (recent.kind === "documents" && recent.directory));
  const runtimes = recents.filter(recent => recent.kind === "runtime");
  const servers = recents.filter(recent => recent.kind === "ssh" || recent.kind === "sshRuntime");
  const [menu, setMenu] = useState<"add" | RecentWorkspace>();
  const [revealed, setRevealed] = useState<string>();
  const choose = (action: () => void) => () => {
    setMenu(undefined);
    action();
  };
  const open = (recent: RecentWorkspace) => {
    if (recent.kind === "ssh") onSsh(recent);
    else if (recent.kind === "sshRuntime") onSshRuntime(recent);
    else onOpenRecent(recent);
  };
  const detail = (recent: RecentWorkspace) => {
    if (recent.kind === "runtime") return recent.url;
    if (recent.kind === "sshRuntime") return `Oxbit runtime · ${recent.remotePath}`;
    if (recent.kind === "ssh") return recent.remotePath;
    return relativeDate(recent.lastOpened, Date.now(), getLocale());
  };
  const row = (recent: RecentWorkspace) => (
    <WorkspaceRow
      key={recent.id}
      name={recent.name}
      icon={ICONS[recent.kind]}
      detail={detail(recent)}
      current={current === recent.id}
      disabled={!!busy}
      revealed={revealed === recent.id}
      onReveal={(next) => setRevealed(next ? recent.id : (id) => (id === recent.id ? undefined : id))}
      onOpen={() => open(recent)}
      onRemove={() => onForget(recent)}
      onMenu={() => {
        setRevealed(undefined);
        setMenu(recent);
      }}
    />
  );
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
      <button className="button primary ios-open-folder" onClick={() => setMenu("add")} disabled={!!busy}>
        <Icon name="plus" />
        {tr("Add…")}
      </button>
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
        {folders.map(row)}
        <p className="muted">{tr("Choose any folder from the Files app. Oxbit keeps access after you relaunch.")}</p>
      </section>
      <section aria-label="Remote workspaces">
        <h2>On your computer</h2>
        {runtimes.map(row)}
      </section>
      <section aria-label="On a server">
        <h2>On a server</h2>
        {servers.map(row)}
        <button className="button ios-open-folder" onClick={() => onSshRuntime()} disabled={!!busy}><Icon name="terminal" />Start Oxbit on This Server…</button>
        <button className="button ios-open-folder" onClick={onSshSettings} disabled={!!busy}><Icon name="settings" />SSH Hosts and Keys…</button>
      </section>
      <section aria-label="Source Control">
        <h2>Source Control</h2>
        <button className="button ios-open-folder" onClick={onClone} disabled={!!busy}><Icon name="copy" />Clone Repository…</button>
        <button className="button ios-open-folder" onClick={onGitSettings} disabled={!!busy}><Icon name="git" />Git Accounts and Commit Author…</button>
      </section>
      {busy && (
        <p className="muted" role="status">
          {busy}
        </p>
      )}
      {menu === "add" && (
        <Dialog title="Add Workspace" className="ios-action-sheet" onClose={() => setMenu(undefined)}>
          <div className="workspace-options">
            <button className="button" onClick={choose(onPick)}><Icon name={ICONS.bookmark} />{tr("Open Folder…")}</button>
            <button className="button" onClick={choose(onConnect)}><Icon name={ICONS.runtime} />{tr("Connect Runtime…")}</button>
            <button className="button" onClick={choose(() => onSsh())}><Icon name={ICONS.ssh} />{tr("Connect with SSH…")}</button>
          </div>
        </Dialog>
      )}
      {menu && menu !== "add" && (
        <Dialog title={menu.name} className="ios-action-sheet" onClose={() => setMenu(undefined)}>
          <div className="workspace-options">
            <button className="button" onClick={choose(() => open(menu))}><Icon name={ICONS[menu.kind]} />{tr("Open")}</button>
            <button className="button danger" onClick={choose(() => onForget(menu))}><Icon name="trash" />{tr("Remove")}</button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
