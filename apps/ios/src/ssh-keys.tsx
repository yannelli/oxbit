import { useState } from "react";
import { ssh, type SshKeyInfo } from "@oxbit/host-ios";

export function SshKeys({ keys, busy, perform, onChange }: {
  keys: SshKeyInfo[];
  busy: boolean;
  perform: (operation: () => Promise<string | void>) => void;
  onChange: (keys: SshKeyInfo[]) => void;
}) {
  const [name, setName] = useState("");
  const [importing, setImporting] = useState(false);
  const [text, setText] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [deleting, setDeleting] = useState<string>();
  const keyName = name.trim() || "iPhone";
  const added = async (key: SshKeyInfo) => {
    onChange(await ssh.keys());
    setName("");
    setText("");
    setPassphrase("");
    return `Added ${key.name} (${key.fingerprint}).`;
  };
  return <section className="ssh-section" aria-label="SSH keys">
    <h3>Keys</h3>
    {!keys.length && <p className="small muted">No keys yet. Generate one here, then add its public key to the server’s authorized_keys file.</p>}
    {keys.map(key => <div className="ssh-row" key={key.id}>
      <div className="ssh-row-text">
        <strong>{key.name}</strong>
        <small>{key.algorithm}</small>
        <code className="ssh-fingerprint">{key.fingerprint}</code>
      </div>
      <div className="ssh-row-actions">
        <button type="button" className="button" disabled={busy} onClick={() => perform(async () => {
          await navigator.clipboard.writeText(key.publicKey);
          return `Copied the public key for ${key.name}.`;
        })}>Copy public key</button>
        {deleting === key.id
          ? <button type="button" className="button danger" disabled={busy} onClick={() => perform(async () => {
            onChange(await ssh.deleteKey(key.id));
            setDeleting(undefined);
            return `Deleted ${key.name}.`;
          })}>Confirm Delete</button>
          : <button type="button" className="button" disabled={busy} onClick={() => setDeleting(key.id)}>Delete</button>}
      </div>
    </div>)}
    <label>Key name<input maxLength={64} autoCapitalize="none" autoCorrect="off" spellCheck={false} aria-label="SSH key name" placeholder="iPhone" value={name} onChange={event => setName(event.target.value)} disabled={busy} /></label>
    <div className="ssh-row-actions">
      <button type="button" className="button primary" disabled={busy} onClick={() => perform(async () => added(await ssh.generateKey(keyName)))}>Generate Ed25519 Key</button>
      <button type="button" className="button" disabled={busy} aria-expanded={importing} onClick={() => setImporting(value => !value)}>Import Key…</button>
    </div>
    {importing && <div className="runtime-form">
      <label>Private key<textarea rows={4} autoCapitalize="none" autoCorrect="off" spellCheck={false} aria-label="Private key" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" value={text} onChange={event => setText(event.target.value)} disabled={busy} /></label>
      <label>Passphrase<input type="password" autoComplete="off" aria-label="Key passphrase" placeholder="Leave empty for an unencrypted key" value={passphrase} onChange={event => setPassphrase(event.target.value)} disabled={busy} /></label>
      <p className="small muted">Oxbit stores the private key in this device’s Keychain without the passphrase. It never leaves the device.</p>
      <div className="ssh-row-actions">
        <button type="button" className="button primary" disabled={busy || !text.trim()} onClick={() => perform(async () =>
          added(await ssh.importKey({ name: keyName, text, passphrase: passphrase || undefined })))}>Import Pasted Key</button>
        <button type="button" className="button" disabled={busy} onClick={() => perform(async () => {
          const [file] = await ssh.pickFiles(false);
          if (!file) return;
          return added(await ssh.importKey({ name: keyName, path: file.path, passphrase: passphrase || undefined }));
        })}>Choose Key File…</button>
      </div>
    </div>}
  </section>;
}
