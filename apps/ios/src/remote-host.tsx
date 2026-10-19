import { useEffect, useState, useSyncExternalStore } from "react";
import { Dialog, Icon } from "@oxbit/ui";
import { presenceLabel } from "@oxbit/feature-runtime";
import type { HostListing, HostProject, RemoteHost } from "@oxbit/workbench";
import type { Offer } from "@oxbit/sdk/tunnel";
import { computerTarget, remoteHosts } from "./remote-hosts.js";

function describe(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** Asks before pairing with the computer in a pairing link, then pairs with it. */
export function RemotePairing({ offer, onPaired, onClose }: { offer: Offer; onPaired: (hostId: string) => void; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return <Dialog title={`Connect to ${offer.n}?`} onClose={() => { if (!busy) onClose(); }}>
    <div className="runtime-form">
      <p>This device can then open folders on {offer.n} and run terminals, Git, and agents there.</p>
      {error && <p className="error-text" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button type="button" className="button" disabled={busy} onClick={onClose}>Cancel</button>
        <button type="button" className="button primary" disabled={busy} aria-busy={busy} onClick={() => {
          setBusy(true);
          setError("");
          void remoteHosts.pair(offer).then(host => onPaired(host.id), failure => {
            setBusy(false);
            setError(describe(failure));
          });
        }}>{busy ? "Connecting…" : "Connect"}</button>
      </div>
    </div>
  </Dialog>;
}

/** A paired computer: presence, the projects it opened recently, and a folder browser. */
export function RemoteHostSheet({ hostId, onOpen, onForget, onClose }: {
  hostId: string;
  /** Resolves to an error message when the folder did not open. */
  onOpen: (path: string) => Promise<string | undefined>;
  onForget: () => Promise<void>;
  onClose: () => void;
}) {
  useSyncExternalStore(remoteHosts.subscribe, () => remoteHosts.version);
  const host = remoteHosts.get(hostId);
  const online = host?.status().state === "online";
  const [projects, setProjects] = useState<HostProject[]>();
  const [home, setHome] = useState<string>();
  const [browsing, setBrowsing] = useState<string>();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  useEffect(() => remoteHosts.watchLan(), []);
  useEffect(() => {
    if (host && !online) void host.connect().catch(() => undefined);
  }, [host, online]);
  useEffect(() => {
    if (!host || !online) return;
    let active = true;
    void Promise.all([host.projects(), host.info()]).then(([listed, info]) => {
      if (!active) return;
      setProjects(listed.projects);
      setHome(info.home);
    }, failure => { if (active) setError(describe(failure)); });
    return () => { active = false; };
  }, [host, online]);

  function open(path: string) {
    setBusy("Opening…");
    setError("");
    void onOpen(path).then(failure => {
      setBusy("");
      if (failure) setError(failure);
    });
  }
  if (!host) return null;
  const close = () => { if (!busy) onClose(); };
  if (browsing) return <Dialog title="Choose a Folder" onClose={close}>
    <RemoteFolderBrowser host={host} start={browsing} home={home ?? browsing} busy={!!busy} error={error}
      onUse={open} onBack={() => setBrowsing(undefined)} />
  </Dialog>;
  return <Dialog title={host.record.name} onClose={close}>
    <div className="runtime-form ssh-connect ssh-browser">
      <p className="small muted" role="status">{presenceLabel(computerTarget(host))}</p>
      {online && <>
        <h3>Recent projects</h3>
        <ul className="ssh-folder-list" aria-label="Recent projects" aria-busy={!projects}>
          {projects?.map(project => <li key={project.path}>
            <button type="button" className="ssh-folder" disabled={!!busy} onClick={() => open(project.path)}>
              <Icon name="folder" /><span>{project.name}<small className="muted"> · {project.path}</small></span>
            </button>
          </li>)}
        </ul>
        {!projects && !error && <p className="small muted" role="status">Loading projects…</p>}
        {projects && !projects.length && <p className="small muted">No recent projects. Browse for a folder.</p>}
      </>}
      {busy && <p className="small muted" role="status">{busy}</p>}
      {error && <p className="error-text" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button type="button" className="button danger" disabled={!!busy} onClick={() => {
          setBusy("Forgetting…");
          void onForget().catch(failure => {
            setBusy("");
            setError(describe(failure));
          });
        }}>Forget</button>
        <button type="button" className="button" disabled={!!busy} onClick={onClose}>Close</button>
        <button type="button" className="button primary" disabled={!!busy || !online || !home} onClick={() => {
          setError("");
          setBrowsing(home);
        }}>Browse Folders…</button>
      </div>
    </div>
  </Dialog>;
}

/** Folders on a paired computer, listed with `host.list`. The computer leaves out hidden folders. */
function RemoteFolderBrowser({ host, start, home, busy, error: openError, onUse, onBack }: {
  host: RemoteHost;
  start: string;
  home: string;
  busy: boolean;
  error: string;
  onUse: (path: string) => void;
  onBack: () => void;
}) {
  const [path, setPath] = useState(start);
  const [listing, setListing] = useState<HostListing>();
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    setListing(undefined);
    setError("");
    void host.list(path).then(listed => { if (active) setListing(listed); }, failure => {
      if (!active) return;
      setListing({ path, entries: [] });
      setError(describe(failure));
    });
    return () => { active = false; };
  }, [host, path]);

  const folders = listing?.entries.filter(entry => entry.kind === "directory").map(entry => entry.name);
  const current = listing?.path ?? path;
  const child = (name: string) => current.endsWith("/") ? current + name : `${current}/${name}`;
  const message = openError || error;
  return <div className="runtime-form ssh-connect ssh-browser">
    <p className="ssh-browser-path" aria-label="Current folder">{current}</p>
    <div className="ssh-row-actions">
      <button type="button" className="button" disabled={!listing?.parent || busy} onClick={() => setPath(listing!.parent!)}>Up</button>
      <button type="button" className="button" disabled={current === home || busy} onClick={() => setPath(home)}>Home Folder</button>
    </div>
    <ul className="ssh-folder-list" aria-label="Folders" aria-busy={!listing}>
      {folders?.map(name => <li key={name}>
        <button type="button" className="ssh-folder" disabled={busy} onClick={() => setPath(child(name))}>
          <Icon name="folder" /><span>{name}</span>
        </button>
      </li>)}
    </ul>
    {!listing && <p className="small muted" role="status">Loading folders…</p>}
    {folders && !folders.length && !error && <p className="small muted">No folders here.</p>}
    {busy && <p className="small muted" role="status">Opening…</p>}
    {message && <p className="error-text" role="alert">{message}</p>}
    <div className="dialog-actions">
      <button type="button" className="button" disabled={busy} onClick={onBack}>Back</button>
      <button type="button" className="button primary" disabled={busy || !listing} onClick={() => onUse(current)}>Use This Folder</button>
    </div>
  </div>;
}
