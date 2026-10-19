import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon, translate as tr } from "@oxbit/ui";
import type { RemoteAccess, RemoteAccessOffer, RemoteAccessPairing, RemoteAccessStatus } from "@oxbit/workbench";
import { Card, type Perform } from "./sections.js";
import { formatLastSeen } from "./store.js";

/** Dark modules of a QR code, row by row. */
export type QrEncoder = (text: string) => boolean[][];

/** Unset until a QR encoder dependency is approved; PairingQr renders nothing without one. */
const qrEncoder: QrEncoder | undefined = undefined;

export function PairingQr({ link, encode = qrEncoder }: { link: string; encode?: QrEncoder }) {
  const modules = useMemo(() => encode?.(link), [encode, link]);
  if (!modules?.length) return null;
  const size = modules.length + 8;
  const path = modules.flatMap((row, y) => row.flatMap((dark, x) => (dark ? [`M${x + 4} ${y + 4}h1v1h-1z`] : []))).join("");
  return (
    <svg className="runtime-qr" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={tr("Pairing QR code")} shapeRendering="crispEdges">
      <rect className="runtime-qr-light" width={size} height={size} />
      <path className="runtime-qr-dark" d={path} />
    </svg>
  );
}

/** "1:59" for the time left on a pairing link. */
export function formatCountdown(ms: number) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

interface Pairing {
  offer?: RemoteAccessOffer;
  result?: RemoteAccessPairing;
  error?: string;
  copied?: boolean;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** This computer's `oxbit remote` host: on/off, status, pairing links, and paired devices. */
export function RemoteAccessCard({ remote, busy, perform }: { remote: RemoteAccess; busy?: string; perform: Perform }) {
  const [status, setStatus] = useState<RemoteAccessStatus>();
  const [loadError, setLoadError] = useState<string>();
  const [pairing, setPairing] = useState<Pairing>();
  const [now, setNow] = useState(Date.now);
  const pairingAbort = useRef<AbortController>(undefined);
  const refresh = useCallback(async () => {
    try {
      setStatus(await remote.status());
      setLoadError(undefined);
    } catch (error) {
      setLoadError(messageOf(error));
    }
  }, [remote]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 30_000);
    return () => {
      clearInterval(timer);
      pairingAbort.current?.abort();
    };
  }, [refresh]);
  const waiting = !!pairing?.offer && !pairing.result && !pairing.error;
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [waiting]);

  const stopPairing = () => {
    pairingAbort.current?.abort();
    setPairing(undefined);
  };
  const startPairing = () => {
    pairingAbort.current?.abort();
    const abort = new AbortController();
    pairingAbort.current = abort;
    setPairing({});
    remote.pair((offer) => {
      setNow(Date.now());
      setPairing({ offer });
    }, abort.signal).then(
      (result) => {
        setPairing((current) => ({ ...current, result }));
        if ("paired" in result) void refresh();
      },
      (error) => {
        if (!abort.signal.aborted) setPairing((current) => ({ ...current, error: messageOf(error) }));
      },
    );
  };
  const on = !!status && (status.enabled || status.running);
  const toggle = (value: boolean) => perform("remoteAccess", async () => {
    if (!value) stopPairing();
    try {
      await (value ? remote.enable() : remote.disable());
    } finally {
      await refresh();
    }
  });
  const offer = pairing?.offer;
  const remaining = offer ? offer.expiresAt - now : 0;
  const expired = !!pairing && (pairing.result ? "expired" in pairing.result : !!offer && remaining <= 0);
  const paired = pairing?.result && "paired" in pairing.result ? pairing.result.paired : undefined;
  const showLink = offer && !pairing?.result && !pairing?.error && !expired;

  return (
    <Card title={tr("Remote access")} icon="power" wide>
      <p className="runtime-hint">{tr("Open folders on this computer from a paired iPhone or iPad on any network.")}</p>
      <label className="runtime-switch">
        <input type="checkbox" role="switch" checked={on} disabled={!status || !!busy} aria-busy={busy === "remoteAccess"}
          onChange={(event) => toggle(event.target.checked)} />
        <span>{tr("Remote access")}</span>
      </label>
      {loadError && <p className="runtime-hint" role="alert">{loadError}</p>}
      {status?.running && (
        <dl className="runtime-facts">
          <div><dt>{tr("Host")}</dt><dd>{status.name}</dd></div>
          <div><dt>{tr("Relay")}</dt><dd>{status.relay.connected ? tr("Connected") : tr("Not connected")}</dd></div>
          <div><dt>{tr("Local network")}</dt><dd>{status.lan.addresses.join(", ") || "—"}</dd></div>
        </dl>
      )}
      {status?.running && (
        <div className="toolbar">
          <button className="button primary" disabled={!!pairing && !offer && !pairing.error} onClick={startPairing}>{tr("Pair a device")}</button>
          {waiting && <button className="button" onClick={stopPairing}>{tr("Cancel")}</button>}
        </div>
      )}
      {pairing && (
        <div className="runtime-remote-pairing" role="status">
          {!offer && !pairing.error && <p className="runtime-hint runtime-searching"><span className="runtime-spinner" aria-hidden="true" />{tr("Creating a pairing link…")}</p>}
          {showLink && <>
            <PairingQr link={offer.link} />
            <p className="runtime-hint">{tr("Open this link on the iPhone or iPad, or paste it into Oxbit's Runtime page there. It works once.")}</p>
            <code className="runtime-command">{offer.link}</code>
            <div className="toolbar">
              <button className="button" onClick={() => void navigator.clipboard.writeText(offer.link).then(() => setPairing((current) => current && { ...current, copied: true }))}>
                {pairing.copied ? tr("Copied") : tr("Copy")}
              </button>
              <span className="runtime-hint">{tr("Expires in {0}", { 0: formatCountdown(remaining) })}</span>
            </div>
          </>}
          {paired && <p className="runtime-remote-result"><Icon name="check" size={14} />{tr("{0} paired", { 0: paired.name })}</p>}
          {expired && <p className="runtime-hint">{tr("The pairing link expired.")}</p>}
          {pairing.error && <p className="runtime-hint" role="alert">{pairing.error}</p>}
        </div>
      )}
      {status && (status.devices.length ? (
        <ul className="runtime-list" aria-label={tr("Paired devices")}>
          {status.devices.map((device) => (
            <li key={device.id}>
              <Icon name="okCircle" />
              <span className="runtime-list-text">{device.name}<small>{tr("Last seen {0}", { 0: formatLastSeen(device.lastSeen) })}</small></span>
              <button className="button" disabled={!!busy} aria-busy={busy === "revoke:" + device.id} aria-label={tr("Revoke {0}", { 0: device.name })}
                onClick={() => perform("revoke:" + device.id, async () => {
                  await remote.revoke(device.id);
                  await refresh();
                })}>
                {tr("Revoke")}
              </button>
            </li>
          ))}
        </ul>
      ) : <p className="runtime-hint">{tr("No paired devices.")}</p>)}
    </Card>
  );
}
