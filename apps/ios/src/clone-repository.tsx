import { useEffect, useRef, useState } from "react";
import { IosFileSystem, IosGitClient, native } from "@oxbit/host-ios";
import { Dialog } from "@oxbit/ui";

export function CloneRepository({ baseGit, onOpen, onClose }: { baseGit?: IosGitClient; onOpen: (directory: string) => Promise<string | undefined>; onClose: () => void }) {
  const [url, setUrl] = useState("");
  const [directory, setDirectory] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState("");
  const controller = useRef<AbortController>(undefined);
  useEffect(() => () => controller.current?.abort(), []);
  return <Dialog title="Clone Repository" onClose={() => { if (!busy) onClose(); }} initialFocus="input">
    <form className="runtime-form" onSubmit={event => {
      event.preventDefault();
      if (busy) return;
      setBusy(true);
      setError("");
      setProgress("Cloning repository…");
      const abort = new AbortController();
      controller.current = abort;
      void (async () => {
        let filesystem: IosFileSystem | undefined;
        let git: IosGitClient | undefined;
        let unsubscribe: (() => void) | undefined;
        try {
          if (baseGit) git = baseGit;
          else {
            filesystem = await IosFileSystem.open(await native.documentsPath());
            git = new IosGitClient(filesystem.id);
          }
          unsubscribe = git.subscribe("git.progress", ({ data }: { data?: string }) => { if (data) setProgress(data); });
          const destination = directory.trim();
          await git.request("git.clone", { url: url.trim(), destination }, { signal: abort.signal });
          setProgress(`Cloned into ${destination}`);
          const failure = await onOpen(destination);
          if (failure) throw new Error(`Repository cloned. ${failure}`);
          onClose();
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure));
        } finally {
          unsubscribe?.();
          if (!baseGit) await git?.dispose();
          await filesystem?.dispose();
          controller.current = undefined;
          setBusy(false);
        }
      })();
    }}>
      <p>Clone an HTTPS repository into the Oxbit folder in Files, then open it.</p>
      <label>Repository URL<input type="url" inputMode="url" required autoCapitalize="none" autoCorrect="off" spellCheck={false} aria-label="Repository URL" placeholder="https://github.com/owner/repository.git" value={url} onChange={event => setUrl(event.target.value)} onBlur={() => {
        if (!directory) setDirectory(url.trim().replace(/\/$/, "").split("/").at(-1)?.replace(/\.git$/, "") ?? "");
      }} disabled={busy} /></label>
      <label>Folder name<input required autoCapitalize="none" autoCorrect="off" spellCheck={false} aria-label="Clone folder name" value={directory} onChange={event => setDirectory(event.target.value)} disabled={busy} /></label>
      <p className="small muted">Add a GitHub or Gitea account in Git Accounts and Commit Author to clone private repositories. Clone uses the default account for the server.</p>
      {progress && <p role="status" className="small muted">{progress}</p>}
      {error && <p className="error-text" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button type="button" className="button" onClick={() => busy ? controller.current?.abort() : onClose()}>{busy ? "Cancel Clone" : "Cancel"}</button>
        <button type="submit" className="button primary" disabled={busy} aria-busy={busy}>{busy ? "Cloning…" : "Clone and Open"}</button>
      </div>
    </form>
  </Dialog>;
}
