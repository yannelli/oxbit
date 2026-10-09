import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Icon, translate as tr } from "@oxbit/ui";
import type { RuntimeConnector, RuntimeStatus } from "@oxbit/workbench";
import { Card, DiscoveredRuntimes, KeepAliveSettings, SavedRuntimes, SshServers, type RuntimeSettingsAccess } from "./sections.js";
import { formatUptime } from "./store.js";

const stateLabels: Record<RuntimeStatus["state"], string> = {
  connected: "Connected",
  connecting: "Connecting…",
  reconnecting: "Reconnecting…",
  disconnected: "Not connected",
  failed: "Connection failed",
};
const stateIcons: Record<RuntimeStatus["state"], string> = {
  connected: "cloudCheck",
  connecting: "sync",
  reconnecting: "sync",
  disconnected: "cloud",
  failed: "cloudOff",
};

export function RuntimePage({ connector, settings, onClose }: {
  connector: RuntimeConnector;
  settings?: RuntimeSettingsAccess;
  onClose?: () => void;
}) {
  const status = useSyncExternalStore(connector.subscribe, connector.status);
  const [busy, setBusy] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [, tick] = useState(0);
  const pairCode = useRef<HTMLInputElement>(null);
  const [pairUrl, setPairUrl] = useState("");
  useEffect(() => {
    const timer = setInterval(() => tick(value => value + 1), 30_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!pairUrl && status.url && status.kind !== "local") setPairUrl(status.url);
  }, [status.url, status.kind, pairUrl]);
  const perform = useCallback((key: string, action: () => Promise<void>) => {
    if (busy) return;
    setBusy(key);
    setActionError(undefined);
    void action().catch(error => setActionError(error instanceof Error ? error.message : String(error))).finally(() => setBusy(undefined));
  }, [busy]);
  const connected = status.state === "connected";
  const quick = connected ? undefined : connector.quickTarget();
  const uptime = connected ? formatUptime(status.startedAt) : undefined;
  const pairWith = (url: string) => {
    setPairUrl(url);
    pairCode.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    pairCode.current?.focus();
  };
  const facts: [string, string | undefined][] = [
    [tr("Host"), status.host],
    [tr("Port"), status.port ? String(status.port) : undefined],
    [tr("Version"), status.version],
    [tr("Uptime"), uptime],
    [tr("Workspace"), status.workspace],
  ];
  return (
    <div className="runtime-page">
      <header className="runtime-hero" data-state={status.state}>
        <div className="runtime-hero-icon"><Icon name={stateIcons[status.state]} size={40} /></div>
        <div className="runtime-hero-body">
          <div className="runtime-title-row">
            <h1>{tr("Runtime")}</h1>
            {onClose && <button className="text-button" onClick={onClose}>{tr("Done")}</button>}
          </div>
          <p className="runtime-name">
            <strong>{status.name ?? quick?.name ?? tr("No runtime connected")}</strong>
            <span className="runtime-badge" data-state={status.state} role="status">{tr(stateLabels[status.state])}</span>
          </p>
          {status.progress && status.state !== "connected" && <p className="runtime-progress" role="status"><span className="runtime-spinner" aria-hidden="true" />{status.progress}</p>}
          {facts.some(([, value]) => value) && (
            <dl className="runtime-facts">
              {facts.filter(([, value]) => value).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
            </dl>
          )}
          <div className="toolbar">
            {connected ? <>
              {connector.disconnect && <button className="button" disabled={!!busy} onClick={() => perform("disconnect", () => connector.disconnect!())}>{tr("Disconnect")}</button>}
              {connector.restart && <button className="button" disabled={!!busy} aria-busy={busy === "restart"} onClick={() => perform("restart", () => connector.restart!())}>
                {busy === "restart" ? tr("Restarting…") : tr("Restart")}</button>}
            </> : quick ? (
              <button className="button primary" disabled={!!busy || status.state === "connecting"} aria-busy={busy === "quick" || status.state === "connecting"}
                onClick={() => perform("quick", () => connector.connect(quick))}>
                {busy === "quick" || status.state === "connecting" ? tr("Connecting…") : tr("Connect to {0}", { 0: quick.name })}
              </button>
            ) : connector.pair && (
              <button className="button primary" onClick={() => pairWith(pairUrl)}>{tr("Pair a runtime")}</button>
            )}
            {!connected && connector.restart && status.kind && <button className="button" disabled={!!busy} onClick={() => perform("restart", () => connector.restart!())}>{tr("Restart")}</button>}
          </div>
        </div>
      </header>
      {(status.error && status.state !== "connected" || actionError) && (
        <section className="runtime-error" role="alert">
          <Icon name="warning" />
          <div>
            <strong>{actionError ?? status.error!.message}</strong>
            {!actionError && status.error?.detail && (
              <details><summary>{tr("Details")}</summary><pre>{status.error.detail}</pre></details>
            )}
          </div>
        </section>
      )}
      <div className="runtime-sections">
        {connected && connector.trust && <TrustCard status={status} busy={busy} perform={perform} trust={value => connector.trust!(value)} />}
        {settings && <KeepAliveSettings settings={settings} />}
        <SavedRuntimes connector={connector} current={connected ? status.targetKey : undefined} busy={busy} perform={perform} />
        {connector.discover && <DiscoveredRuntimes connector={connector} busy={busy} perform={perform} onPair={pairWith} />}
        {connector.sshHosts && connector.startSsh && <SshServers connector={connector} busy={busy} perform={perform} />}
        {connector.pair && <PairCard pair={connector.pair.bind(connector)} startCommand={connector.startCommand} url={pairUrl} setUrl={setPairUrl} codeRef={pairCode} busy={busy} perform={perform} />}
      </div>
    </div>
  );
}

function TrustCard({ status, busy, perform, trust }: {
  status: RuntimeStatus; busy?: string; perform: (key: string, action: () => Promise<void>) => void; trust: (value: boolean) => Promise<void>;
}) {
  return (
    <Card title={tr("Workspace trust")} icon="lock">
      <p className="runtime-hint">{tr("Trust allows terminals, tasks, Git hooks and language servers to execute workspace code.")}</p>
      <label className="runtime-switch">
        <input type="checkbox" role="switch" checked={!!status.trusted} disabled={!!busy || status.owner === false}
          onChange={event => { const value = event.target.checked; perform("trust", () => trust(value)); }} />
        <span>{status.trusted ? tr("Trusted") : tr("Restricted")}</span>
      </label>
      {status.owner === false && <p className="runtime-hint">{tr("Only the workspace owner can change trust.")}</p>}
    </Card>
  );
}

function PairCard({ pair, startCommand, url, setUrl, codeRef, busy, perform }: {
  pair: (url: string, code: string) => Promise<void>; startCommand?: string; url: string; setUrl: (value: string) => void; codeRef: React.RefObject<HTMLInputElement | null>;
  busy?: string; perform: (key: string, action: () => Promise<void>) => void;
}) {
  const [code, setCode] = useState("");
  return (
    <Card title={tr("Pair with a runtime")} icon="plus" wide>
      <form className="runtime-pair" onSubmit={event => { event.preventDefault(); perform("pair", async () => { await pair(url.trim(), code.trim()); setCode(""); }); }}>
        {startCommand && <>
          <p className="runtime-hint">{tr("Start a runtime on your computer, then enter its address and owner pairing code.")}</p>
          <code className="runtime-command">{startCommand}</code>
        </>}
        <label>{tr("Runtime URL")}
          <input type="url" inputMode="url" required autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="http://192.168.1.10:51234"
            aria-label={tr("Runtime URL")} value={url} onChange={event => setUrl(event.target.value)} disabled={!!busy} />
        </label>
        <label>{tr("Pairing code")}
          <input ref={codeRef} required autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false}
            aria-label={tr("Pairing code")} value={code} onChange={event => setCode(event.target.value)} disabled={!!busy} />
        </label>
        <div className="toolbar">
          <button type="submit" className="button primary" disabled={!!busy} aria-busy={busy === "pair"}>{busy === "pair" ? tr("Connecting…") : tr("Pair and connect")}</button>
        </div>
      </form>
    </Card>
  );
}
