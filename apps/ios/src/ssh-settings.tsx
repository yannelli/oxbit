import { useEffect, useState } from "react";
import { ssh, type SshHost, type SshHostInput, type SshKeyInfo } from "@oxbit/host-ios";
import { Dialog } from "@oxbit/ui";
import { SshKeys } from "./ssh-keys.js";

export function describe(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function hostAddress(host: Pick<SshHost, "username" | "hostname" | "port">) {
  return `${host.username}@${host.hostname}${host.port === 22 ? "" : `:${host.port}`}`;
}

const blank: SshHostInput = { label: "", hostname: "", port: 22, username: "", auth: "key" };

export function SshSettings({ onClose }: { onClose: () => void }) {
  const [hosts, setHosts] = useState<SshHost[]>([]);
  const [keys, setKeys] = useState<SshKeyInfo[]>([]);
  const [editing, setEditing] = useState<SshHostInput>();
  const [removing, setRemoving] = useState<string>();
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  useEffect(() => {
    let active = true;
    void Promise.all([ssh.hosts(), ssh.keys()]).then(([hosts, keys]) => {
      if (!active) return;
      setHosts(hosts);
      setKeys(keys);
    }, failure => { if (active) setError(describe(failure)); }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, []);
  function perform(operation: () => Promise<string | void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    setStatus("");
    void operation().then(message => setStatus(message ?? ""), failure => setError(describe(failure))).finally(() => setBusy(false));
  }
  const refresh = async () => setHosts(await ssh.hosts());
  const keyName = (id?: string) => keys.find(key => key.id === id)?.name ?? "Missing key";
  return <Dialog title="SSH Hosts and Keys" onClose={() => { if (!busy) onClose(); }}>
    <div className="runtime-form ssh-settings">
      {editing ? <HostForm host={editing} keys={keys} busy={busy} onCancel={() => setEditing(undefined)} onSave={host => perform(async () => {
        const saved = await ssh.saveHost(host);
        await refresh();
        setEditing(undefined);
        return `Saved ${saved.label}.`;
      })} /> : <section className="ssh-section" aria-label="SSH hosts">
        <h3>Hosts</h3>
        {!hosts.length && <p className="small muted">Add a server to open its folders over SFTP.</p>}
        {hosts.map(host => <div className="ssh-row" key={host.id}>
          <div className="ssh-row-text">
            <strong>{host.label}</strong>
            <small>{hostAddress(host)} · {host.auth === "key" ? keyName(host.keyId) : host.passwordSaved ? "Saved password" : "Password"}</small>
            {host.knownKeys?.map(known => <code className="ssh-fingerprint" key={known.algorithm}>{known.algorithm} {known.fingerprint}</code>)}
          </div>
          <div className="ssh-row-actions">
            <button type="button" className="button" disabled={busy} onClick={() => setEditing({ ...host })}>Edit</button>
            {removing === host.id
              ? <button type="button" className="button danger" disabled={busy} onClick={() => perform(async () => {
                await ssh.removeHost(host.id);
                await refresh();
                setRemoving(undefined);
                return `Removed ${host.label}.`;
              })}>Confirm Remove</button>
              : <button type="button" className="button" disabled={busy} onClick={() => setRemoving(host.id)}>Remove</button>}
            {!!host.knownKeys?.length && <button type="button" className="button" disabled={busy} onClick={() => perform(async () => {
              await ssh.forgetHostKey(host.id);
              await refresh();
              return `Forgot the saved host key for ${host.label}. The next connection asks you to confirm its fingerprint.`;
            })}>Forget saved host key</button>}
            {host.passwordSaved && <button type="button" className="button" disabled={busy} onClick={() => perform(async () => {
              await ssh.forgetPassword(host.id);
              await refresh();
              return `Forgot the saved password for ${host.label}.`;
            })}>Forget saved password</button>}
          </div>
        </div>)}
        <button type="button" className="button primary" disabled={busy} onClick={() => setEditing({ ...blank, keyId: keys[0]?.id })}>Add Host…</button>
      </section>}
      {!editing && <SshKeys keys={keys} busy={busy} perform={perform} onChange={setKeys} />}
      {error && <p className="error-text" role="alert">{error}</p>}
      {status && <p role="status">{status}</p>}
      {!editing && <div className="dialog-actions">
        <button type="button" className="button" disabled={busy} onClick={onClose}>Done</button>
      </div>}
    </div>
  </Dialog>;
}

function HostForm({ host, keys, busy, onSave, onCancel }: {
  host: SshHostInput;
  keys: SshKeyInfo[];
  busy: boolean;
  onSave: (host: SshHostInput) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(host);
  const update = (patch: Partial<SshHostInput>) => setDraft(value => ({ ...value, ...patch }));
  const needsKey = draft.auth === "key" && !keys.some(key => key.id === draft.keyId);
  return <form className="runtime-form" aria-label={host.id ? "Edit host" : "Add host"} onSubmit={event => {
    event.preventDefault();
    onSave({
      id: draft.id, label: draft.label.trim() || draft.hostname.trim(), hostname: draft.hostname.trim(), port: draft.port,
      username: draft.username.trim(), auth: draft.auth, keyId: draft.auth === "key" ? draft.keyId : undefined,
    });
  }}>
    <h3>{host.id ? "Edit Host" : "Add Host"}</h3>
    <label>Name<input maxLength={64} aria-label="Host name" placeholder="Build server" value={draft.label} onChange={event => update({ label: event.target.value })} disabled={busy} /></label>
    <label>Hostname<input required maxLength={253} inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} aria-label="Hostname" placeholder="server.example.com" value={draft.hostname} onChange={event => update({ hostname: event.target.value })} disabled={busy} /></label>
    <label>Port<input required type="number" min={1} max={65535} aria-label="Port" value={draft.port} onChange={event => update({ port: Number(event.target.value) })} disabled={busy} /></label>
    <label>Username<input required maxLength={64} autoCapitalize="none" autoCorrect="off" spellCheck={false} aria-label="Username" value={draft.username} onChange={event => update({ username: event.target.value })} disabled={busy} /></label>
    <label>Sign in with<select aria-label="Authentication" value={draft.auth} onChange={event => update({ auth: event.target.value as SshHostInput["auth"] })} disabled={busy}>
      <option value="key">SSH key</option>
      <option value="password">Password</option>
    </select></label>
    {draft.auth === "key" && (keys.length
      ? <label>Key<select aria-label="SSH key" value={draft.keyId ?? ""} onChange={event => update({ keyId: event.target.value })} disabled={busy}>
        {!draft.keyId && <option value="">Choose a key</option>}
        {keys.map(key => <option key={key.id} value={key.id}>{key.name} ({key.algorithm})</option>)}
      </select></label>
      : <p className="small muted">Generate or import a key first.</p>)}
    {draft.auth === "password" && <p className="small muted">Oxbit asks for the password when you connect. You choose whether to save it in the Keychain.</p>}
    <div className="dialog-actions">
      <button type="button" className="button" disabled={busy} onClick={onCancel}>Cancel</button>
      <button type="submit" className="button primary" disabled={busy || needsKey}>Save Host</button>
    </div>
  </form>;
}
