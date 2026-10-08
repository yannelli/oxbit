import { useEffect, useState, type KeyboardEvent } from "react";
import { GIT_ACCOUNT_KEY, native, type GitAccount, type GitCredentials, type IosGitClient } from "@oxbit/host-ios";
import { Dialog, Icon, Select } from "@oxbit/ui";
import { CommitSigning } from "./commit-signing.js";

type Provider = GitAccount["provider"];
interface RepositoryStatus { repository?: boolean; upstream?: string | null; remotes?: { name: string; url: string }[] }

const PROVIDERS: Record<Provider, string> = { github: "GitHub", gitea: "Gitea" };

export function GitSettings({ repository, onClose }: { repository?: IosGitClient; onClose: () => void }) {
  const [credentials, setCredentials] = useState<GitCredentials>({ accounts: [] });
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [adding, setAdding] = useState<Provider>();
  const [token, setToken] = useState("");
  const [giteaUrl, setGiteaUrl] = useState("");
  const [removing, setRemoving] = useState<string>();
  const [remote, setRemote] = useState<{ host?: string }>();
  const [binding, setBinding] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  useEffect(() => {
    let active = true;
    void Promise.all([
      native.gitCredentials({ operation: "get" }),
      repository?.request<RepositoryStatus>("git.status").catch(() => undefined),
      repository ? native.storageGet<string>(repository.id, GIT_ACCOUNT_KEY) : undefined,
    ]).then(([value, repositoryStatus, bound]) => {
      if (!active) return;
      setCredentials(value);
      setName(value.name ?? "");
      setEmail(value.email ?? "");
      if (repositoryStatus?.repository) setRemote({ host: remoteHost(repositoryStatus) });
      setBinding(typeof bound === "string" ? bound : "");
    }, failure => {
      if (active) setError(failure instanceof Error ? failure.message : String(failure));
    }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [repository]);
  async function perform(operation: () => Promise<string>) {
    if (busy) return;
    setBusy(true);
    setError("");
    setStatus("");
    try { setStatus(await operation()); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  }
  function closeEditor() {
    setAdding(undefined);
    setToken("");
  }
  function addAccount() {
    if (!adding || !token.trim() || (adding === "gitea" && !giteaUrl.trim())) return;
    void perform(async () => {
      const next = await native.gitCredentials(adding === "github"
        ? { operation: "addGitHub", token: token.trim() }
        : { operation: "addGitea", url: giteaUrl.trim(), token: token.trim() });
      const added = next.accounts.find(account => !credentials.accounts.some(known => known.id === account.id));
      setCredentials(next);
      closeEditor();
      return added ? `Added ${added.login} on ${added.host}.` : "Account token updated.";
    });
  }
  function submitOnEnter(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    addAccount();
  }
  function removeAccount(account: GitAccount) {
    void perform(async () => {
      setCredentials(await native.gitCredentials({ operation: "remove", id: account.id }));
      setRemoving(undefined);
      if (repository && binding === account.id) {
        await native.storageSet(repository.id, GIT_ACCOUNT_KEY, null);
        setBinding("");
      }
      return `Removed ${account.login} from ${account.host}.`;
    });
  }
  const giteaBase = giteaServerUrl(giteaUrl);
  const candidates = credentials.accounts.filter(account => !remote?.host || account.host === remote.host);
  const fallback = remote?.host ? candidates.find(account => account.isDefault) : undefined;
  const chosen = candidates.find(account => account.id === binding);
  const used = chosen ?? fallback;
  return <Dialog title="Git Accounts and Commit Author" className="git-settings" onClose={() => { if (!busy) onClose(); }} initialFocus="input">
    <form className="runtime-form" onSubmit={event => {
      event.preventDefault();
      void perform(async () => {
        setCredentials(await native.gitCredentials({ operation: "save", name: name.trim(), email: email.trim() }));
        return "Commit author saved.";
      });
    }}>
      <p>Use this author for commits in device folders. An existing repository’s Git identity takes precedence.</p>
      <label>Author name<input required maxLength={256} autoComplete="name" aria-label="Git author name" value={name} onChange={event => setName(event.target.value)} disabled={busy} /></label>
      <label>Author email<input type="email" required maxLength={320} autoComplete="email" autoCapitalize="none" aria-label="Git author email" value={email} onChange={event => setEmail(event.target.value)} disabled={busy} /></label>
      <CommitSigning authorName={name} authorEmail={email} />
      <section className="git-section" aria-labelledby="git-accounts-title">
        <h3 id="git-accounts-title">Accounts</h3>
        {credentials.accounts.length ? <ul className="git-account-list">
          {credentials.accounts.map(account => <li key={account.id} className="git-account">
            <span className="git-account-name">
              <span><strong>{account.login}</strong>{account.isDefault && <span className="git-account-badge">Default</span>}</span>
              <small>{PROVIDERS[account.provider]} · {account.host}</small>
            </span>
            <span className="git-account-actions">
              {removing === account.id ? <>
                <button type="button" className="button" disabled={busy} onClick={() => setRemoving(undefined)}>Keep</button>
                <button type="button" className="button danger" disabled={busy} onClick={() => removeAccount(account)}>Remove</button>
              </> : <>
                {!account.isDefault && <button type="button" className="button" disabled={busy} onClick={() => void perform(async () => {
                  setCredentials(await native.gitCredentials({ operation: "setDefault", id: account.id }));
                  return `${account.login} is the default for ${account.host}.`;
                })}>Make Default</button>}
                <button type="button" className="icon-button" aria-label={`Remove ${account.login} on ${account.host}`} disabled={busy} onClick={() => setRemoving(account.id)}><Icon name="trash" /></button>
              </>}
            </span>
          </li>)}
        </ul> : <p className="small muted">Public HTTPS repositories work without an account.</p>}
        {adding ? <div className="git-account-editor" role="group" aria-label={`Add ${PROVIDERS[adding]} account`}>
          {adding === "gitea" && <label>Gitea server URL<input type="text" inputMode="url" autoComplete="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={2048} aria-label="Gitea server URL" placeholder="https://gitea.example.com" value={giteaUrl} onChange={event => setGiteaUrl(event.target.value)} onKeyDown={submitOnEnter} disabled={busy} autoFocus /></label>}
          <label>{adding === "github" ? "Personal access token" : "Access token"}<input type="password" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={4096} aria-label={`${PROVIDERS[adding]} access token`} value={token} onChange={event => setToken(event.target.value)} onKeyDown={submitOnEnter} disabled={busy} autoFocus={adding === "github"} /></label>
          <p className="small muted">{adding === "github"
            ? "For private repositories, grant access to the repository. Pushing needs Contents read and write permission. The token stays in your device’s Keychain."
            : "Give the token the read:user scope and the write:repository scope. To clone and pull only, read:repository is sufficient. Oxbit sends the token only to this server."}</p>
          {adding === "github" && <button type="button" className="text-button" onClick={() => void native.external("https://github.com/settings/personal-access-tokens/new")}>Create a GitHub token</button>}
          {adding === "gitea" && giteaBase && <button type="button" className="text-button" onClick={() => void native.external(`${giteaBase}/user/settings/applications`)}>Create a Gitea token</button>}
          <div className="dialog-actions">
            <button type="button" className="button" disabled={busy} onClick={closeEditor}>Cancel</button>
            <button type="button" className="button primary" disabled={busy || !token.trim() || (adding === "gitea" && !giteaUrl.trim())} aria-busy={busy} onClick={addAccount}>{busy ? "Checking…" : "Add Account"}</button>
          </div>
        </div> : <div className="git-account-add">
          <button type="button" className="button" disabled={busy} onClick={() => setAdding("github")}><Icon name="plus" />Add GitHub Account</button>
          <button type="button" className="button" disabled={busy} onClick={() => setAdding("gitea")}><Icon name="plus" />Add Gitea Account</button>
        </div>}
      </section>
      {remote && <section className="git-section" aria-labelledby="git-repository-title">
        <h3 id="git-repository-title">This Repository</h3>
        <Select label="Account for this repository" value={chosen?.id ?? ""} disabled={busy || !candidates.length}
          options={[
            { value: "", label: fallback ? `Default (${fallback.login})` : "Default account" },
            ...candidates.map(account => ({ value: account.id, label: remote.host ? account.login : `${account.login} · ${account.host}` })),
          ]}
          onChange={value => repository && void perform(async () => {
            await native.storageSet(repository.id, GIT_ACCOUNT_KEY, value || null);
            setBinding(value);
            return "Repository account saved.";
          })} />
        <p className="small muted">{!remote.host ? "Add an HTTPS remote to use an account. The choice applies to remotes on the account’s server."
          : used ? `Fetch, pull, and push to ${remote.host} use ${used.login}.`
            : `Add an account for ${remote.host} to use private repositories.`}</p>
      </section>}
      {error && <p className="error-text" role="alert">{error}</p>}
      {status && <p role="status">{status}</p>}
      <div className="dialog-actions">
        <button type="button" className="button" disabled={busy} onClick={onClose}>Done</button>
        <button type="submit" className="button primary" disabled={busy} aria-busy={busy}>{busy ? "Saving…" : "Save Author"}</button>
      </div>
    </form>
  </Dialog>;
}

/** Returns the HTTPS host of the upstream remote, then `origin`, then the first remote. */
export function remoteHost(status: RepositoryStatus): string | undefined {
  const remotes = status.remotes ?? [];
  const upstream = status.upstream?.split("/")[0];
  const remote = remotes.find(item => item.name === upstream) ?? remotes.find(item => item.name === "origin") ?? remotes[0];
  try {
    const url = new URL(remote?.url ?? "");
    return url.protocol === "https:" && url.hostname ? url.host.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
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
