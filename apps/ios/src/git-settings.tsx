import { useEffect, useState } from "react";
import { native, type GitAccount } from "@oxbit/host-ios";
import { Dialog } from "@oxbit/ui";

export function GitSettings({ onClose }: { onClose: () => void }) {
  const [account, setAccount] = useState<GitAccount>();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    let active = true;
    void native.gitCredentials({ operation: "get" }).then(value => {
      if (!active) return;
      setAccount(value);
      setName(value.name ?? "");
      setEmail(value.email ?? "");
    }, failure => {
      if (active) setError(failure instanceof Error ? failure.message : String(failure));
    }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, []);
  async function perform(operation: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    setSaved(false);
    try { await operation(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  }
  return <Dialog title="GitHub and Commit Author" onClose={() => { if (!busy) onClose(); }} initialFocus="input">
    <form className="runtime-form" onSubmit={event => {
      event.preventDefault();
      void perform(async () => {
        setAccount(await native.gitCredentials({ operation: "save", name: name.trim(), email: email.trim(), token: token.trim() || undefined }));
        setToken("");
        setSaved(true);
      });
    }}>
      <p>Use this author for commits in device folders. An existing repository’s Git identity takes precedence.</p>
      <label>Author name<input required maxLength={256} autoComplete="name" aria-label="Git author name" value={name} onChange={event => setName(event.target.value)} disabled={busy} /></label>
      <label>Author email<input type="email" required maxLength={320} autoComplete="email" autoCapitalize="none" aria-label="Git author email" value={email} onChange={event => setEmail(event.target.value)} disabled={busy} /></label>
      <p>{account?.authenticated ? `Connected to GitHub as ${account.login}.` : "Public HTTPS repositories work without a token."}</p>
      <label>GitHub personal access token<input type="password" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={4096} aria-label="GitHub personal access token" placeholder={account?.authenticated ? "Leave empty to keep the saved token" : "Optional for public repositories"} value={token} onChange={event => setToken(event.target.value)} disabled={busy} /></label>
      <p className="small muted">For private repositories, grant access to the repository. Pushing needs Contents read and write permission. The token stays in your device’s Keychain.</p>
      <button type="button" className="text-button" onClick={() => void native.external("https://github.com/settings/personal-access-tokens/new")}>Create a GitHub token</button>
      {account?.authenticated && <button type="button" className="button" disabled={busy} onClick={() => void perform(async () => {
        setAccount(await native.gitCredentials({ operation: "forget" }));
        setToken("");
      })}>Disconnect GitHub</button>}
      {error && <p className="error-text" role="alert">{error}</p>}
      {saved && <p role="status">Git settings saved.</p>}
      <div className="dialog-actions">
        <button type="button" className="button" disabled={busy} onClick={onClose}>Done</button>
        <button type="submit" className="button primary" disabled={busy} aria-busy={busy}>{busy ? "Saving…" : token.trim() ? "Connect GitHub and Save" : "Save Author"}</button>
      </div>
    </form>
  </Dialog>;
}
