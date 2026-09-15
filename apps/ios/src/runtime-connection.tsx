import { useEffect, useState } from "react";
import type { Session } from "@oxbit/app-workbench";
import { Dialog } from "@oxbit/ui";

export function RuntimeConnection({ session, savedUrl, connect, disconnect, onClose }: {
  session?: Session;
  savedUrl?: string;
  connect: (url: string, code?: string) => Promise<void>;
  disconnect: () => Promise<void>;
  onClose: () => void;
}) {
  const runtime = session?.runtime;
  const [url, setUrl] = useState(runtime?.url ?? savedUrl ?? "");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [connected, setConnected] = useState(!!runtime?.connected);
  const [trusted, setTrusted] = useState(!!runtime?.session?.trusted);
  useEffect(() => {
    setConnected(!!runtime?.connected);
    setTrusted(!!runtime?.session?.trusted);
    const connection = runtime?.subscribe("connection.change", () => setConnected(!!runtime.connected));
    const trust = runtime?.subscribe("workspace.trust", ({ trusted }) => setTrusted(trusted === true));
    return () => { connection?.(); trust?.(); };
  }, [runtime]);
  async function perform(operation: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try { await operation(); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  return <Dialog title="Runtime Connection" onClose={() => { if (!busy) onClose(); }} initialFocus="input">
    {connected && runtime ? <div className="runtime-form">
      <p>Connected to <strong>{runtime.url}</strong>.</p>
      <p>Workspace tools: <strong>{trusted ? "Trusted" : "Restricted"}</strong></p>
      <p>Trust allows terminals, tasks, Git hooks, and language servers to run code on your computer.</p>
      <button className="button primary" disabled={busy || runtime.session?.owner === false} onClick={() => void perform(async () => {
        await runtime.trust(!trusted);
        setTrusted(!!runtime.session?.trusted);
        session?.workbench.touch();
      })}>{busy ? "Working…" : trusted ? "Revoke workspace trust" : "Trust workspace tools"}</button>
      {runtime.session?.owner === false && <p className="muted">Only the workspace owner can change trust.</p>}
      <button className="button" disabled={busy} onClick={() => void perform(async () => { await disconnect(); onClose(); })}>Disconnect</button>
    </div> : <form className="runtime-form" onSubmit={event => {
      event.preventDefault();
      void perform(async () => { await connect(url, code); onClose(); });
    }}>
      <p>Connect to a project on your computer to use its files, terminal, Git, and language tools.</p>
      <details>
        <summary>Start a runtime on your computer</summary>
        <p>Run this in your project folder, then enter the network address and pairing code below:</p>
        <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>OXBIT_ORIGINS=tauri://localhost oxbit --host 0.0.0.0 --foreground --no-open</pre>
      </details>
      <label>Runtime URL<input type="url" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} required aria-label="Runtime URL" placeholder="http://192.168.1.10:9277" value={url} onChange={event => setUrl(event.target.value)} disabled={busy} /></label>
      <p className="small muted">Use your computer’s network address. Your iPhone and computer must be able to reach each other.</p>
      <label>Pairing code<input type="password" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} aria-label="Pairing code" placeholder="Leave empty to use a saved connection" value={code} onChange={event => setCode(event.target.value)} disabled={busy} /></label>
      <p className="small muted">Enter the owner pairing code shown by the runtime. Connecting opens that computer’s workspace; your on-device folders stay available.</p>
      <div className="dialog-actions">
        <button type="button" className="button" disabled={busy} onClick={onClose}>Cancel</button>
        <button type="submit" className="button primary" disabled={busy} aria-busy={busy}>{busy ? "Connecting…" : "Connect"}</button>
      </div>
    </form>}
    {error && <p className="error-text" role="alert">{error}</p>}
  </Dialog>;
}
