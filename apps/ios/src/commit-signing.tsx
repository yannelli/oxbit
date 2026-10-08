import { useEffect, useState } from "react";
import { native, type CommitSigningRequest, type CommitSigningState } from "@oxbit/host-ios";

/** Emails in the key's user IDs, lowercased, from `Name <email>` or a bare address. */
export function userIdEmails(userIds: string[]): string[] {
  return userIds.flatMap(userId => {
    const email = /<([^<>\s]+@[^<>\s]+)>\s*$/.exec(userId)?.[1] ?? (/^[^\s<>]+@[^\s<>]+$/.test(userId.trim()) ? userId.trim() : undefined);
    return email ? [email.toLowerCase()] : [];
  });
}

function groupFingerprint(fingerprint: string) {
  return fingerprint.match(/.{1,4}/g)?.join(" ") ?? fingerprint;
}

export function CommitSigning({ authorName, authorEmail }: { authorName: string; authorEmail: string }) {
  const [state, setState] = useState<CommitSigningState>();
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [importing, setImporting] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [secretKey, setSecretKey] = useState("");
  const [passphrase, setPassphrase] = useState("");
  useEffect(() => {
    let active = true;
    void native.commitSigning({ operation: "get" }).then(value => {
      if (active) setState(value);
    }, failure => {
      if (active) setError(failure instanceof Error ? failure.message : String(failure));
    }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, []);
  async function perform(operation: () => Promise<string | void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    setStatus("");
    try { setStatus((await operation()) ?? ""); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  }
  const request = (value: CommitSigningRequest, message?: string) => perform(async () => {
    setState(await native.commitSigning(value));
    return message;
  });
  const importKey = () => perform(async () => {
    setState(await native.commitSigning({ operation: "import", secretKey, passphrase: passphrase || undefined }));
    setImporting(false);
    setSecretKey("");
    setPassphrase("");
    return "Signing key imported.";
  });
  const key = state?.key;
  const email = authorEmail.trim().toLowerCase();
  const mismatch = key && email && !userIdEmails(key.userIds).includes(email);
  return <section className="commit-signing" aria-labelledby="commit-signing-title">
    <h3 id="commit-signing-title">Commit Signing</h3>
    {key ? <>
      <dl>
        <dt>Key ID</dt><dd>{key.keyId}</dd>
        <dt>Fingerprint</dt><dd>{groupFingerprint(key.fingerprint)}</dd>
        <dt>User IDs</dt><dd>{key.userIds.map(userId => <span key={userId}>{userId}</span>)}</dd>
        <dt>Created</dt><dd>{new Date(key.createdAt * 1000).toLocaleDateString()}</dd>
      </dl>
      <label className="commit-signing-switch">
        <span>Sign commits</span>
        <input type="checkbox" role="switch" aria-label="Sign commits" checked={!!state?.enabled} disabled={busy}
          onChange={event => void request({ operation: "setEnabled", enabled: event.target.checked })} />
      </label>
      {mismatch && <p className="warning-text">The key’s user IDs do not include {authorEmail.trim()}. GitHub and Gitea mark commits with this author email as unverified.</p>}
      <p className="small muted">Add the public key to your GitHub or Gitea GPG keys so signed commits show as verified.</p>
      <div className="commit-signing-actions">
        <button type="button" className="button" disabled={busy} onClick={() => void perform(async () => {
          await native.copyText(key.publicKey);
          return "Public key copied.";
        })}>Copy Public Key</button>
        <button type="button" className="button" onClick={() => void native.external("https://github.com/settings/gpg/new")}>Add Key on GitHub</button>
      </div>
      {confirmRemove
        ? <div className="commit-signing-actions">
          <p>Remove this key from the device? Commits stop being signed. Keep a copy if you need the key elsewhere.</p>
          <button type="button" className="button" disabled={busy} onClick={() => setConfirmRemove(false)}>Cancel</button>
          <button type="button" className="button danger" disabled={busy} onClick={() => void perform(async () => {
            setState(await native.commitSigning({ operation: "remove" }));
            setConfirmRemove(false);
            return "Signing key removed.";
          })}>Remove Key</button>
        </div>
        : <button type="button" className="button" disabled={busy} onClick={() => setConfirmRemove(true)}>Remove Signing Key…</button>}
    </> : <>
      <p>Sign commits made in device folders with an OpenPGP key. The secret key stays in this device’s Keychain.</p>
      {!importing && <div className="commit-signing-actions">
        <button type="button" className="button" disabled={busy || !authorName.trim() || !authorEmail.trim()}
          onClick={() => void request({ operation: "generate", name: authorName.trim(), email: authorEmail.trim() }, "Signing key created.")}>Create Signing Key</button>
        <button type="button" className="button" disabled={busy} onClick={() => { setImporting(true); setStatus(""); }}>Import Key…</button>
      </div>}
      {!importing && (!authorName.trim() || !authorEmail.trim()) && <p className="small muted">Enter the author name and email to create a key for them.</p>}
      {importing && <>
        <label>Armored secret key<textarea rows={5} autoCapitalize="none" autoCorrect="off" spellCheck={false} aria-label="Armored secret key"
          placeholder="-----BEGIN PGP PRIVATE KEY BLOCK-----" value={secretKey} onChange={event => setSecretKey(event.target.value)} disabled={busy} /></label>
        <label>Key passphrase<input type="password" autoComplete="off" aria-label="Key passphrase" placeholder="Only if the key has one" value={passphrase}
          onChange={event => setPassphrase(event.target.value)} disabled={busy}
          onKeyDown={event => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            if (secretKey.trim()) void importKey();
          }} /></label>
        <p className="small muted">Oxbit removes the passphrase and keeps the unlocked key in this device’s Keychain.</p>
        <div className="commit-signing-actions">
          <button type="button" className="button" disabled={busy} onClick={() => { setImporting(false); setSecretKey(""); setPassphrase(""); setError(""); }}>Cancel</button>
          <button type="button" className="button primary" disabled={busy || !secretKey.trim()} onClick={() => void importKey()}>Import Key</button>
        </div>
      </>}
    </>}
    {error && <p className="error-text" role="alert">{error}</p>}
    {status && <p role="status">{status}</p>}
  </section>;
}
