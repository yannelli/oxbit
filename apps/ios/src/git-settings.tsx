import { useEffect, useState } from "react";
import { native, type GitAccount } from "@oxbit/host-ios";
import { Dialog } from "@oxbit/ui";
import { CommitSigning } from "./commit-signing.js";

export function GitSettings({ onClose }: { onClose: () => void }) {
  const [account, setAccount] = useState<GitAccount>();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  const [giteaUrl, setGiteaUrl] = useState("");
  const [giteaToken, setGiteaToken] = useState("");
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
      setGiteaUrl(value.gitea?.url ?? "");
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
  const giteaBase = giteaServerUrl(giteaUrl);
  return <Dialog title="Git Accounts and Commit Author" onClose={() => { if (!busy) onClose(); }} initialFocus="input">
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
      <CommitSigning authorName={name} authorEmail={email} />
      <p>{account?.authenticated ? `Connected to GitHub as ${account.login}.` : "Public HTTPS repositories work without a token."}</p>
      <label>GitHub personal access token<input type="password" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={4096} aria-label="GitHub personal access token" placeholder={account?.authenticated ? "Leave empty to keep the saved token" : "Optional for public repositories"} value={token} onChange={event => setToken(event.target.value)} disabled={busy} /></label>
      <p className="small muted">For private repositories, grant access to the repository. Pushing needs Contents read and write permission. The token stays in your device’s Keychain.</p>
      <button type="button" className="text-button" onClick={() => void native.external("https://github.com/settings/personal-access-tokens/new")}>Create a GitHub token</button>
      {account?.authenticated && <button type="button" className="button" disabled={busy} onClick={() => void perform(async () => {
        setAccount(await native.gitCredentials({ operation: "forget" }));
        setToken("");
      })}>Disconnect GitHub</button>}
      <p>{account?.gitea?.authenticated ? `Connected to Gitea at ${account.gitea.host} as ${account.gitea.login}.` : "Connect a Gitea server to use its private repositories."}</p>
      <label>Gitea server URL<input type="text" inputMode="url" autoComplete="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={2048} aria-label="Gitea server URL" placeholder="https://gitea.example.com" value={giteaUrl} onChange={event => setGiteaUrl(event.target.value)} disabled={busy} /></label>
      <label>Gitea access token<input type="password" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={4096} aria-label="Gitea access token" placeholder={account?.gitea?.authenticated ? "Enter a new token to reconnect" : "Required to connect Gitea"} value={giteaToken} onChange={event => setGiteaToken(event.target.value)} disabled={busy} /></label>
      <p className="small muted">Give the token the read:user scope and the write:repository scope. To clone and pull only, read:repository is sufficient. Oxbit sends the token only to this server.</p>
      {giteaBase && <button type="button" className="text-button" onClick={() => void native.external(`${giteaBase}/user/settings/applications`)}>Create a Gitea token</button>}
      <button type="button" className="button" disabled={busy || !giteaUrl.trim() || !giteaToken.trim()} onClick={() => void perform(async () => {
        const connected = await native.gitCredentials({ operation: "connectGitea", url: giteaUrl.trim(), token: giteaToken.trim() });
        setAccount(connected);
        setGiteaUrl(connected.gitea?.url ?? giteaUrl);
        setGiteaToken("");
        setSaved(true);
      })}>Connect Gitea</button>
      {account?.gitea?.authenticated && <button type="button" className="button" disabled={busy} onClick={() => void perform(async () => {
        setAccount(await native.gitCredentials({ operation: "forgetGitea" }));
        setGiteaToken("");
      })}>Disconnect Gitea</button>}
      {error && <p className="error-text" role="alert">{error}</p>}
      {saved && <p role="status">Git settings saved.</p>}
      <div className="dialog-actions">
        <button type="button" className="button" disabled={busy} onClick={onClose}>Done</button>
        <button type="submit" className="button primary" disabled={busy} aria-busy={busy}>{busy ? "Saving…" : token.trim() ? "Connect GitHub and Save" : "Save Author"}</button>
      </div>
    </form>
  </Dialog>;
}

/** Returns the HTTPS server base for the token link, or nothing while the address is incomplete. */
export function giteaServerUrl(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash) return undefined;
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return undefined;
  }
}
