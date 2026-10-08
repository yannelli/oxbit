import { useEffect, useState } from "react";
import { ssh, type GitSshPrompt, type SshKeyInfo } from "@oxbit/host-ios";
import { Dialog } from "@oxbit/ui";
import { ChangedKey } from "./ssh-connect.js";
import { describe } from "./ssh-settings.js";

const address = (host: string, port: number) => port === 22 ? host : `${host}:${port}`;

/** Answers the prompt a Git over SSH request left for `rootId`; `onDone(true)` runs it again. */
export function SshGitPrompt({ rootId, onDone, onManage }: { rootId: string; onDone: (retry: boolean) => void; onManage: () => void }) {
  const [prompt, setPrompt] = useState<GitSshPrompt>();
  const [keys, setKeys] = useState<SshKeyInfo[]>([]);
  const [keyId, setKeyId] = useState("");
  const [username, setUsername] = useState("");
  const [busy, setBusy] = useState(true);
  const [forgotten, setForgotten] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void (async () => {
      const found = await ssh.gitPrompt(rootId);
      if (!active) return;
      if (!found) return onDone(false);
      if (found.status === "keyRequired") {
        const list = await ssh.keys();
        if (!active) return;
        setKeys(list);
        setKeyId(list[0]?.id ?? "");
        setUsername(found.username);
      }
      setPrompt(found);
    })().catch(failure => { if (active) setError(describe(failure)); }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [rootId, onDone]);
  function perform(operation: () => Promise<void>) {
    setBusy(true);
    setError("");
    void operation().catch(failure => setError(describe(failure))).finally(() => setBusy(false));
  }
  const cancel = <button type="button" className="button" disabled={busy} onClick={() => onDone(false)}>Cancel</button>;
  const failure = error && <p className="error-text" role="alert">{error}</p>;
  if (prompt?.status === "keyRequired") {
    const server = address(prompt.hostname, prompt.port);
    return <Dialog title="Choose SSH Key" onClose={() => { if (!busy) onDone(false); }} initialFocus="select">
      <form className="runtime-form" onSubmit={event => {
        event.preventDefault();
        if (busy || !keyId || !username.trim()) return;
        perform(async () => {
          await ssh.saveHost({ label: prompt.hostname, hostname: prompt.hostname, port: prompt.port, username: username.trim(), auth: "key", keyId });
          onDone(true);
        });
      }}>
        <p>This remote is on <strong>{server}</strong>. Choose the key to sign in with. Oxbit saves it as an SSH host, so other repositories on this server use it too.</p>
        {keys.length ? <>
          <label>SSH key<select aria-label="SSH key" value={keyId} onChange={event => setKeyId(event.target.value)} disabled={busy}>
            {keys.map(key => <option key={key.id} value={key.id}>{key.name} ({key.algorithm})</option>)}
          </select></label>
          <label>User name<input autoCapitalize="none" autoCorrect="off" spellCheck={false} aria-label="SSH user name" value={username} onChange={event => setUsername(event.target.value)} disabled={busy} /></label>
        </> : <p>Generate or import a key in SSH Hosts and Keys, add its public key to the server, then try again.</p>}
        {failure}
        <div className="dialog-actions">
          {!keys.length && <button type="button" className="button" disabled={busy} onClick={onManage}>SSH Hosts and Keys…</button>}
          {cancel}
          {keys.length > 0 && <button type="submit" className="button primary" disabled={busy || !keyId || !username.trim()}>Save and Continue</button>}
        </div>
      </form>
    </Dialog>;
  }
  if (prompt?.status === "hostChanged") {
    const server = address(prompt.hostKey.host, prompt.hostKey.port);
    return <Dialog title="Host Key Changed" danger onClose={() => { if (!busy) onDone(false); }}>
      <div className="runtime-form ssh-host-key">
        <p className="error-text" role="alert">The host key for <strong>{server}</strong> does not match the saved key. Oxbit did not connect.</p>
        <dl className="ssh-key-facts">
          {prompt.known.map(known => <ChangedKey key={known.algorithm} label="Saved" algorithm={known.algorithm} fingerprint={known.fingerprint} />)}
          <ChangedKey label="Presented" algorithm={prompt.hostKey.algorithm} fingerprint={prompt.hostKey.fingerprint} />
        </dl>
        {forgotten
          ? <p role="status">Forgot the saved host key. Run the Git command again to review the new fingerprint.</p>
          : <p className="small muted">A changed key follows a server reinstall, or someone is intercepting the connection. Forget the saved key only if the server administrator confirms the change.</p>}
        {failure}
        <div className="dialog-actions">
          {forgotten ? <button type="button" className="button primary" onClick={() => onDone(false)}>Done</button> : <>
            {cancel}
            <button type="button" className="button danger" disabled={busy} onClick={() => perform(async () => {
              await ssh.gitForgetHostKey(rootId);
              setForgotten(true);
            })}>Forget saved host key</button>
          </>}
        </div>
      </div>
    </Dialog>;
  }
  return <Dialog title="Confirm Host Key" onClose={() => { if (!busy) onDone(false); }}>
    <div className="runtime-form ssh-host-key">
      {prompt && <>
        <p>This is the first connection to <strong>{address(prompt.hostKey.host, prompt.hostKey.port)}</strong>. Check that the fingerprint matches the server before you trust it.</p>
        <dl className="ssh-key-facts">
          <dt>Key type</dt><dd>{prompt.hostKey.algorithm}</dd>
          <dt>Fingerprint</dt><dd><code className="ssh-fingerprint">{prompt.hostKey.fingerprint}</code></dd>
        </dl>
      </>}
      {failure}
      <div className="dialog-actions">
        {cancel}
        <button type="button" className="button primary" disabled={busy || !prompt} onClick={() => prompt && perform(async () => {
          await ssh.gitTrust(rootId, prompt.hostKey.fingerprint);
          onDone(true);
        })}>Trust and Continue</button>
      </div>
    </div>
  </Dialog>;
}
