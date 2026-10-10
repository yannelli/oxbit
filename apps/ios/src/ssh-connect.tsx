import { useEffect, useRef, useState } from "react";
import { ssh, type KnownHostKey, type SshHost, type SshHostKey } from "@oxbit/host-ios";
import { Dialog } from "@oxbit/ui";
import { describe, hostAddress } from "./ssh-settings.js";
import { SshFolderBrowser } from "./ssh-folder-browser.js";
import { absoluteFolder, loadHomeFolders, saveHomeFolder } from "./ssh-folders.js";

export interface SshTarget {
  hostId: string;
  path: string;
}
type Prompt =
  | { kind: "unknown"; hostKey: SshHostKey }
  | { kind: "changed"; hostKey: SshHostKey; known: KnownHostKey[] };

/** `runtime` starts Oxbit on the server; `files` opens the folder over SFTP. `browse` lists the preset host's folders after it connects. */
export function SshConnect({ preset, mode = "files", browse = false, progress, lastFolders = {}, onOpen, onManage, onClose }: {
  preset?: SshTarget;
  mode?: "files" | "runtime";
  browse?: boolean;
  progress?: string;
  lastFolders?: Record<string, string>;
  onOpen: (target: SshTarget & { label: string }) => Promise<string | undefined>;
  onManage: () => void;
  onClose: () => void;
}) {
  const [hosts, setHosts] = useState<SshHost[]>();
  const [hostId, setHostId] = useState(preset?.hostId ?? "");
  const [path, setPath] = useState(preset?.path ?? "~");
  const runtime = mode === "runtime";
  const [password, setPassword] = useState("");
  const [savePassword, setSavePassword] = useState(false);
  const [needsPassword, setNeedsPassword] = useState(false);
  const [prompt, setPrompt] = useState<Prompt>();
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [browsing, setBrowsing] = useState<string>();
  const autoConnect = useRef(!!preset);
  const intent = useRef<"open" | "browse">(browse ? "browse" : "open");
  const homeFolders = useRef<Record<string, string>>({});
  const host = hosts?.find(item => item.id === hostId);
  const defaultFolder = (id: string) => homeFolders.current[id] ?? lastFolders[id] ?? "~";

  async function connect(target: SshHost, next = intent.current) {
    intent.current = next;
    setError("");
    setPrompt(undefined);
    const outcome = await ssh.connect(target.id, password || undefined, savePassword);
    if (outcome.status === "passwordRequired") {
      setNeedsPassword(true);
      setError(`Enter the password for ${hostAddress(target)}.`);
    } else if (outcome.status === "hostUnknown") setPrompt({ kind: "unknown", hostKey: outcome.hostKey });
    else if (outcome.status === "hostChanged") setPrompt({ kind: "changed", hostKey: outcome.hostKey, known: outcome.known });
    else {
      setPassword("");
      if (next === "browse") setBrowsing(absoluteFolder(outcome.home, homeFolders.current[target.id] ?? "~"));
      else await open(target, path);
    }
  }
  async function open(target: SshHost, folder: string) {
    const failure = await onOpen({ hostId: target.id, path: folder, label: target.label });
    if (failure) setError(failure);
    else onClose();
  }
  function perform(operation: () => Promise<void>) {
    setBusy(true);
    void operation().catch(failure => setError(describe(failure))).finally(() => setBusy(false));
  }
  useEffect(() => {
    let active = true;
    void Promise.all([ssh.hosts(), loadHomeFolders()]).then(([list, homes]) => {
      if (!active) return;
      homeFolders.current = homes;
      setHosts(list);
      const initial = list.find(item => item.id === hostId) ?? list[0];
      if (!initial) return;
      setHostId(initial.id);
      if (!preset) setPath(defaultFolder(initial.id));
      if (autoConnect.current && initial.id === preset?.hostId && (initial.auth === "key" || initial.passwordSaved))
        return connect(initial);
    }).catch(failure => { if (active) setError(describe(failure)); }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, []);

  const title = prompt?.kind === "changed" ? "Host Key Changed" : prompt ? "Confirm Host Key"
    : browsing ? "Choose a Folder" : runtime ? "Start Oxbit on This Server" : "Connect with SSH";
  return <Dialog title={title} danger={prompt?.kind === "changed"} onClose={() => { if (!busy) onClose(); }} initialFocus={prompt ? undefined : "select"}>
    {prompt && host ? <div className="runtime-form ssh-host-key">
      {prompt.kind === "unknown" ? <>
        <p>This is the first connection to <strong>{prompt.hostKey.host}:{prompt.hostKey.port}</strong>. Check that the fingerprint matches the server before you trust it.</p>
        <dl className="ssh-key-facts">
          <dt>Key type</dt><dd>{prompt.hostKey.algorithm}</dd>
          <dt>Fingerprint</dt><dd><code className="ssh-fingerprint">{prompt.hostKey.fingerprint}</code></dd>
        </dl>
        <p className="small muted">On the server, run ssh-keygen -lf on its host key file to see the same fingerprint.</p>
      </> : <>
        <p className="error-text" role="alert">The host key for <strong>{prompt.hostKey.host}:{prompt.hostKey.port}</strong> does not match the saved key. Oxbit did not connect.</p>
        <dl className="ssh-key-facts">
          {prompt.known.map(known => <ChangedKey key={known.algorithm} label="Saved" algorithm={known.algorithm} fingerprint={known.fingerprint} />)}
          <ChangedKey label="Presented" algorithm={prompt.hostKey.algorithm} fingerprint={prompt.hostKey.fingerprint} />
        </dl>
        <p className="small muted">A changed key follows a server reinstall, or someone is intercepting the connection. Forget the saved key only if the server administrator confirms the change.</p>
      </>}
      {error && <p className="error-text" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button type="button" className="button" disabled={busy} onClick={() => { setPrompt(undefined); setError(""); }}>Cancel</button>
        {prompt.kind === "unknown"
          ? <button type="button" className="button primary" disabled={busy} onClick={() => perform(async () => {
            await ssh.trust(host.id, prompt.hostKey);
            await connect(host);
          })}>Trust and Connect</button>
          : <button type="button" className="button danger" disabled={busy} onClick={() => perform(async () => {
            await ssh.forgetHostKey(host.id);
            setPrompt(undefined);
            setError("Forgot the saved host key. Connect again to review the new fingerprint.");
          })}>Forget saved host key</button>}
      </div>
    </div> : browsing && host ? <SshFolderBrowser hostId={host.id} start={browsing} home={browsing}
      onUse={folder => {
        setPath(folder);
        setBrowsing(undefined);
        perform(() => open(host, folder));
      }}
      onSetHome={async folder => { homeFolders.current = await saveHomeFolder(host.id, folder); }}
      onBack={() => setBrowsing(undefined)} /> : <form className="runtime-form ssh-connect" onSubmit={event => {
      event.preventDefault();
      if (host && !busy) perform(() => connect(host, "open"));
    }}>
      {runtime && <p>Oxbit installs its runtime on the server and runs terminals, tasks, and agents there. Linux x64 and arm64 servers and macOS Apple Silicon servers are supported.</p>}
      {hosts && !hosts.length ? <p>Add a server in SSH Hosts and Keys first.</p> : <>
        <label>Server<select aria-label="Server" value={hostId} onChange={event => {
          setHostId(event.target.value);
          setPath(defaultFolder(event.target.value));
          setNeedsPassword(false);
          setError("");
        }} disabled={busy}>
          {hosts?.map(item => <option key={item.id} value={item.id}>{item.label} ({hostAddress(item)})</option>)}
        </select></label>
        <label>Remote folder<input autoCapitalize="none" autoCorrect="off" spellCheck={false} aria-label="Remote folder" placeholder="~ (home folder)" value={path} onChange={event => setPath(event.target.value)} disabled={busy} /></label>
        <button type="button" className="button" disabled={busy || !host} onClick={() => { if (host) perform(() => connect(host, "browse")); }}>Browse Folders…</button>
        <p className="small muted">A relative path starts in your home folder on the server.</p>
        {host?.auth === "password" && <>
          <label>Password<input type="password" autoComplete="current-password" aria-label="SSH password" required={needsPassword || !host.passwordSaved}
            placeholder={host.passwordSaved ? "Leave empty to use the saved password" : undefined} value={password} onChange={event => setPassword(event.target.value)} disabled={busy} /></label>
          <label className="ssh-check"><input type="checkbox" checked={savePassword} onChange={event => setSavePassword(event.target.checked)} disabled={busy} />Save password in the Keychain</label>
        </>}
      </>}
      {busy && progress && <p className="small muted" role="status">{progress}</p>}
      {error && <p className="error-text" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button type="button" className="button" disabled={busy} onClick={onManage}>SSH Hosts and Keys…</button>
        <button type="button" className="button" disabled={busy} onClick={onClose}>Cancel</button>
        <button type="submit" className="button primary" disabled={busy || !host} aria-busy={busy}>
          {busy && hosts ? (runtime ? "Starting…" : "Connecting…") : runtime ? "Start" : "Connect"}
        </button>
      </div>
    </form>}
  </Dialog>;
}

export function ChangedKey({ label, algorithm, fingerprint }: { label: string; algorithm: string; fingerprint: string }) {
  return <>
    <dt>{label}</dt>
    <dd>{algorithm}<br /><code className="ssh-fingerprint">{fingerprint}</code></dd>
  </>;
}
