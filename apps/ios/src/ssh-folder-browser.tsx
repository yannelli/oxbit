import { useEffect, useRef, useState } from "react";
import { ssh } from "@oxbit/host-ios";
import { Icon } from "@oxbit/ui";
import { describe } from "./ssh-settings.js";
import { childFolder, parentFolder } from "./ssh-folders.js";

/** Folders on a connected host, listed through one SFTP root at `/`. Hidden folders are left out. */
export function SshFolderBrowser({ hostId, start, home, onUse, onSetHome, onBack }: {
  hostId: string;
  /** Absolute paths. */
  start: string;
  home: string;
  onUse: (path: string) => void;
  onSetHome: (path: string) => Promise<void>;
  onBack: () => void;
}) {
  const [path, setPath] = useState(start);
  const [folders, setFolders] = useState<string[]>();
  const [homeFolder, setHomeFolder] = useState(home);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const root = useRef<Promise<string>>(undefined);
  root.current ??= ssh.openRoot(hostId, "/").then(opened => opened.id);
  useEffect(() => () => { void root.current?.then(id => ssh.closeRoot(id)).catch(() => {}); }, []);

  useEffect(() => {
    let active = true;
    setFolders(undefined);
    setError("");
    void root.current!.then(id => ssh.list(id, path.slice(1))).then(entries => {
      if (active) setFolders(entries.filter(entry => entry.kind === "directory" && !entry.name.startsWith(".")).map(entry => entry.name));
    }, failure => {
      if (!active) return;
      setFolders([]);
      setError(describe(failure));
    });
    return () => { active = false; };
  }, [path]);

  function go(next: string) {
    setStatus("");
    setPath(next);
  }
  return <div className="runtime-form ssh-connect ssh-browser">
    <p className="ssh-browser-path" aria-label="Current folder">{path}</p>
    <div className="ssh-row-actions">
      <button type="button" className="button" disabled={path === "/"} onClick={() => go(parentFolder(path))}>Up</button>
      <button type="button" className="button" disabled={path === homeFolder} onClick={() => go(homeFolder)}>Home Folder</button>
      <button type="button" className="button" disabled={path === homeFolder} onClick={() => {
        setError("");
        void onSetHome(path).then(() => {
          setHomeFolder(path);
          setStatus(`${path} is the home folder for this server.`);
        }, failure => setError(describe(failure)));
      }}>Set as Home Folder</button>
    </div>
    <ul className="ssh-folder-list" aria-label="Folders" aria-busy={!folders}>
      {folders?.map(name => <li key={name}>
        <button type="button" className="ssh-folder" onClick={() => go(childFolder(path, name))}>
          <Icon name="folder" /><span>{name}</span>
        </button>
      </li>)}
    </ul>
    {!folders && <p className="small muted" role="status">Loading folders…</p>}
    {folders && !folders.length && !error && <p className="small muted">No folders here.</p>}
    {status && <p className="small muted" role="status">{status}</p>}
    {error && <p className="error-text" role="alert">{error}</p>}
    <div className="dialog-actions">
      <button type="button" className="button" onClick={onBack}>Back</button>
      <button type="button" className="button primary" onClick={() => onUse(path)}>Use This Folder</button>
    </div>
  </div>;
}
