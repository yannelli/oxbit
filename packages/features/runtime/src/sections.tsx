import { useEffect, useState, type ReactNode } from "react";
import { Icon, Select, translate as tr } from "@oxbit/ui";
import type { DiscoveredRuntime, RuntimeConnector, RuntimeTarget, SshHostSummary } from "@oxbit/workbench";
import { AUTO_RECONNECT_SETTING, KEEP_ALIVE_SETTING, keepAliveOptions } from "./configuration.js";

/** Reads and writes runtime settings with or without a workbench kernel. */
export interface RuntimeSettingsAccess {
  get<T>(id: string): T | undefined;
  set(id: string, value: unknown): void | Promise<void>;
}

export type Perform = (key: string, action: () => Promise<void>) => void;

export function Card({ title, icon, children, wide = false }: { title: string; icon: string; children: ReactNode; wide?: boolean }) {
  return (
    <section className={wide ? "runtime-card wide" : "runtime-card"} aria-label={title}>
      <h2><Icon name={icon} size={14} />{title}</h2>
      {children}
    </section>
  );
}

export function KeepAliveSettings({ settings }: { settings: RuntimeSettingsAccess }) {
  const [keepAlive, setKeepAlive] = useState(String(settings.get(KEEP_ALIVE_SETTING) ?? "75s"));
  const [reconnect, setReconnect] = useState(settings.get<boolean>(AUTO_RECONNECT_SETTING) !== false);
  return (
    <Card title={tr("Keep alive")} icon="clock">
      <p className="runtime-hint">{tr("How long a runtime Oxbit started keeps running after the last client disconnects. Terminals and tasks continue while it runs.")}</p>
      <Select label={tr("Keep Runtime Alive")} value={keepAlive}
        options={keepAliveOptions.map(value => ({ value, label: tr(value) }))}
        onChange={value => { setKeepAlive(value); void settings.set(KEEP_ALIVE_SETTING, value); }} />
      <label className="runtime-switch">
        <input type="checkbox" role="switch" checked={reconnect}
          onChange={event => { setReconnect(event.target.checked); void settings.set(AUTO_RECONNECT_SETTING, event.target.checked); }} />
        <span>{tr("Reconnect Automatically")}</span>
      </label>
    </Card>
  );
}

export function SavedRuntimes({ connector, current, busy, perform }: { connector: RuntimeConnector; current?: string; busy?: string; perform: Perform }) {
  const [targets, setTargets] = useState<RuntimeTarget[]>();
  useEffect(() => {
    let live = true;
    void connector.recents().then(value => { if (live) setTargets(value); }, () => { if (live) setTargets([]); });
    return () => { live = false; };
  }, [connector, current]);
  if (!targets?.length) return null;
  return (
    <Card title={tr("Saved runtimes")} icon="cloud">
      <ul className="runtime-list">
        {targets.map(target => (
          <li key={target.key} aria-current={target.key === current ? "true" : undefined}>
            <Icon name={target.kind === "ssh" ? "terminal" : "cloud"} />
            <span className="runtime-list-text">{target.name}<small>{target.detail ?? target.url ?? target.path}</small></span>
            {target.key === current ? <span className="runtime-badge" data-state="connected">{tr("In use")}</span> : (
              <button className="button" disabled={!!busy} aria-busy={busy === target.key}
                onClick={() => perform(target.key, () => connector.connect(target))}>
                {busy === target.key ? tr("Connecting…") : tr("Connect")}
              </button>
            )}
            {connector.forget && target.key !== current && (
              <button className="icon-button" aria-label={tr("Forget {0}", { 0: target.name })} disabled={!!busy}
                onClick={() => perform("forget:" + target.key, async () => {
                  await connector.forget!(target);
                  setTargets(list => list?.filter(item => item.key !== target.key));
                })}>
                <Icon name="x" size={14} />
              </button>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function DiscoveredRuntimes({ connector, busy, perform, onPair }: { connector: RuntimeConnector; busy?: string; perform: Perform; onPair: (url: string) => void }) {
  const [found, setFound] = useState<DiscoveredRuntime[]>([]);
  useEffect(() => connector.discover?.(setFound), [connector]);
  return (
    <Card title={tr("On this network")} icon="share">
      {found.length ? (
        <ul className="runtime-list">
          {found.map(runtime => {
            const key = "lan:" + runtime.runtimeId;
            return (
              <li key={runtime.runtimeId}>
                <Icon name="cloud" />
                <span className="runtime-list-text">{runtime.name}<small>{`${runtime.host}:${runtime.port}${runtime.version ? ` · v${runtime.version}` : ""}`}</small></span>
                <button className={runtime.paired ? "button primary" : "button"} disabled={!!busy} aria-busy={busy === key}
                  onClick={() => runtime.paired
                    ? perform(key, () => connector.connect({ key, kind: "url", name: runtime.name, url: runtime.url, runtimeId: runtime.runtimeId }))
                    : onPair(runtime.url)}>
                  {busy === key ? tr("Connecting…") : runtime.paired ? tr("Connect") : tr("Pair")}
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="runtime-hint runtime-searching"><span className="runtime-spinner" aria-hidden="true" />{tr("Looking for runtimes on this network…")}</p>
      )}
      <p className="runtime-hint">{tr("Run oxbit --lan on your computer to list it here.")}</p>
    </Card>
  );
}

export function SshServers({ connector, busy, perform }: { connector: RuntimeConnector; busy?: string; perform: Perform }) {
  const [hosts, setHosts] = useState<SshHostSummary[]>();
  const [paths, setPaths] = useState<Record<string, string>>({});
  useEffect(() => {
    let live = true;
    void connector.sshHosts?.().then(value => { if (live) setHosts(value); }, () => { if (live) setHosts([]); });
    return () => { live = false; };
  }, [connector]);
  return (
    <Card title={tr("SSH servers")} icon="terminal">
      {hosts?.length ? (
        <ul className="runtime-list">
          {hosts.map(host => {
            const key = "ssh:" + host.id, path = paths[host.id] ?? host.lastPath ?? "~";
            return (
              <li key={host.id} className="runtime-ssh">
                <span className="runtime-list-text">{host.label}<small>{host.detail}</small></span>
                <input aria-label={tr("Folder on {0}", { 0: host.label })} value={path} autoCapitalize="none" autoCorrect="off" spellCheck={false}
                  onChange={event => setPaths(current => ({ ...current, [host.id]: event.target.value }))} />
                <button className="button" disabled={!!busy || !path.trim()} aria-busy={busy === key}
                  onClick={() => perform(key, () => connector.startSsh!(host.id, path.trim()))}>
                  {busy === key ? tr("Starting…") : tr("Start Oxbit on this server")}
                </button>
              </li>
            );
          })}
        </ul>
      ) : hosts && <p className="runtime-hint">{tr("No SSH hosts saved yet.")}</p>}
      {connector.manageSsh && <button className="button" onClick={() => connector.manageSsh!()}>{tr("Manage SSH hosts…")}</button>}
    </Card>
  );
}
