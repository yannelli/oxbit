import { useEffect, useRef, useState } from "react";
import { ssh, type KnownHostKey, type SshHost, type SshHostKey } from "@oxbit/host-ios";
import { Dialog } from "@oxbit/ui";
import { describe, hostAddress } from "./ssh-settings.js";

export interface SshTarget {
  hostId: string;
  path: string;
}
type Prompt =
  | { kind: "unknown"; hostKey: SshHostKey }
  | { kind: "changed"; hostKey: SshHostKey; known: KnownHostKey[] };

export function SshConnect({ preset, onOpen, onManage, onClose }: {
  preset?: SshTarget;
  onOpen: (target: SshTarget & { label: string }) => Promise<string | undefined>;
  onManage: () => void;
  onClose: () => void;
}) {
  const [hosts, setHosts] = useState<SshHost[]>();
  const [hostId, setHostId] = useState(preset?.hostId ?? "");
  const [path, setPath] = useState(preset?.path ?? "~");
  const [password, setPassword] = useState("");
  const [savePassword, setSavePassword] = useState(false);
  const [needsPassword, setNeedsPassword] = useState(false);
  const [prompt, setPrompt] = useState<Prompt>();
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const autoConnect = useRef(!!preset);
  const host = hosts?.find(item => item.id === hostId);

  async function connect(target: SshHost) {
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
      const failure = await onOpen({ hostId: target.id, path, label: target.label });
      if (failure) setError(failure);
      else onClose();
    }
  }
  function perform(operation: () => Promise<void>) {
    setBusy(true);
    void operation().catch(failure => setError(describe(failure))).finally(() => setBusy(false));
  }
  useEffect(() => {
    let active = true;
    void ssh.hosts().then(list => {
      if (!active) return;
      setHosts(list);
      const initial = list.find(item => item.id === hostId) ?? list[0];
      if (!initial) return;
      setHostId(initial.id);
      if (autoConnect.current && initial.id === preset?.hostId && (initial.auth === "key" || initial.passwordSaved))
        return connect(initial);
    }).catch(failure => { if (active) setError(describe(failure)); }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, []);

  const title = prompt?.kind === "changed" ? "Host Key Changed" : prompt ? "Confirm Host Key" : "Connect with SSH";
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
    </div> : <form className="runtime-form" onSubmit={event => {
      event.preventDefault();
      if (host && !busy) perform(() => connect(host));
    }}>
      {hosts && !hosts.length ? <p>Add a server in SSH Hosts and Keys first.</p> : <>
        <label>Server<select aria-label="Server" value={hostId} onChange={event => { setHostId(event.target.value); setNeedsPassword(false); setError(""); }} disabled={busy}>
          {hosts?.map(item => <option key={item.id} value={item.id}>{item.label} ({hostAddress(item)})</option>)}
        </select></label>
        <label>Remote folder<input autoCapitalize="none" autoCorrect="off" spellCheck={false} aria-label="Remote folder" placeholder="~ (home folder)" value={path} onChange={event => setPath(event.target.value)} disabled={busy} /></label>
        <p className="small muted">A relative path starts in your home folder on the server.</p>
        {host?.auth === "password" && <>
          <label>Password<input type="password" autoComplete="current-password" aria-label="SSH password" required={needsPassword || !host.passwordSaved}
            placeholder={host.passwordSaved ? "Leave empty to use the saved password" : undefined} value={password} onChange={event => setPassword(event.target.value)} disabled={busy} /></label>
          <label className="ssh-check"><input type="checkbox" checked={savePassword} onChange={event => setSavePassword(event.target.checked)} disabled={busy} />Save password in the Keychain</label>
        </>}
      </>}
      {error && <p className="error-text" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button type="button" className="button" disabled={busy} onClick={onManage}>SSH Hosts and Keys…</button>
        <button type="button" className="button" disabled={busy} onClick={onClose}>Cancel</button>
        <button type="submit" className="button primary" disabled={busy || !host} aria-busy={busy}>{busy && hosts ? "Connecting…" : "Connect"}</button>
      </div>
    </form>}
  </Dialog>;
}

function ChangedKey({ label, algorithm, fingerprint }: { label: string; algorithm: string; fingerprint: string }) {
  return <>
    <dt>{label}</dt>
    <dd>{algorithm}<br /><code className="ssh-fingerprint">{fingerprint}</code></dd>
  </>;
}
