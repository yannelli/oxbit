import { useEffect, useId, useRef, useState } from "react";
import { Icon, IconButton, TooltipLayer } from "@oxbit/ui";
import type { FeatureOptions } from "@oxbit/sdk";
import type { LanguageService } from "./index.js";

const labels: Record<string, string> = {
  installing: "Installing…", ready: "Running", starting: "Starting…", restarting: "Restarting…", stopping: "Stopping…",
  stopped: "Stopped", unavailable: "Unavailable", disconnected: "Disconnected", failed: "Failed",
};
export function LanguageStatus({ language, o }: { language: LanguageService; o: FeatureOptions }) {
  const [, render] = useState(0);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<string[]>([]);
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    const off = language.subscribe(() => render(n => n + 1));
    const context = o.kernel.context.subscribe(() => render(n => n + 1));
    void language.refreshStatus();
    return () => { off(); context(); };
  }, [language, o]);
  useEffect(() => {
    const element = popup.current;
    if (!open || !element) return;
    const rect = trigger.current!.getBoundingClientRect();
    const width = Math.min(384, innerWidth - 16);
    Object.assign(element.style, {
      width: `${width}px`, left: `${Math.max(8, Math.min(rect.right - width, innerWidth - width - 8))}px`,
      bottom: `${innerHeight - rect.top + 6}px`, maxHeight: `${Math.max(100, rect.top - 16)}px`,
    });
    element.showPopover();
    element.focus();
    const resize = () => setOpen(false);
    window.addEventListener("resize", resize);
    return () => { element.hidePopover(); window.removeEventListener("resize", resize); };
  }, [open]);
  const servers = language.servers;
  const running = servers.filter(s => s.state === "ready").length;
  const busy = pending.length > 0 || servers.some(s => ["installing", "starting", "restarting", "stopping"].includes(s.state));
  const failed = servers.some(s => s.state === "failed");
  const state = busy ? "starting" : failed ? "failed" : running ? "ready" : "stopped";
  const close = () => { setOpen(false); trigger.current?.focus(); };
  async function control(server: string, action: "start" | "stop" | "restart") {
    setPending(ids => [...ids, server]);
    try { await language.control(server, action); }
    catch (error) { o.workbench.notify(String(error), "error"); }
    finally { setPending(ids => ids.filter(id => id !== server)); }
  }
  return <>
    <button ref={trigger} className="lsp-status-trigger" aria-label={`Language Servers: ${running} running`}
      data-tooltip={`Language Servers · ${busy ? "Working…" : `${running} running`}`}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => { if (open) close(); else { setOpen(true); void language.refreshStatus(); } }}>
      <span className="lsp-status-icon"><Icon name="languageServer" size={14} /><i className="lsp-state-dot" data-state={state} /></span>
      <span>LSP</span><span className="lsp-running-count">{running}</span>
    </button>
    {open && <div ref={popup} id={id} popover="auto" role="dialog" aria-label="Language Servers" tabIndex={-1}
      className="lsp-status-popover" data-tooltip-root=""
      onToggle={event => { if (event.newState === "closed" && popup.current === event.currentTarget) setOpen(false); }}
      onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); } }}>
      <header><div><strong>Language Servers</strong><span role="status">{running} running · {servers.length} for this document</span></div>
        <IconButton icon="x" label="Close Language Servers" onClick={close} /></header>
      <div className="lsp-server-list">{!servers.length && <p className="muted">No language server for the current document.</p>}{servers.map(server => {
        const waiting = pending.includes(server.id) || ["installing", "starting", "restarting", "stopping"].includes(server.state);
        return <section className="lsp-server" key={server.id} aria-label={server.name} aria-busy={waiting}>
          <div className="lsp-server-heading"><Icon name="languageServer" size={18} />
            <div className="lsp-server-name"><strong>{server.name}</strong><small>{server.detail}</small></div>
            <span className="lsp-server-state" data-state={server.state}><i className="lsp-state-dot" data-state={server.state} />{labels[server.state] ?? server.state}</span>
          </div>
          <div className="lsp-server-footer"><span>{!server.available ? "Connect and trust a runtime to start." : server.state === "ready" ? "Language intelligence is active" : server.state === "failed" ? "Could not run language server" : waiting ? "Updating language server…" : "Start to enable language intelligence"}</span>
            <div className="lsp-server-actions">
              <IconButton icon={server.state === "failed" ? "refresh" : "play"} label={`${server.state === "failed" ? "Retry" : "Start"} ${server.name}`} disabled={!server.available || waiting || server.state === "ready"} onClick={() => void control(server.id, "start")} />
              <IconButton icon="refresh" label={`Restart ${server.name}`} disabled={!server.available || waiting || server.state !== "ready"} onClick={() => void control(server.id, "restart")} />
              <IconButton icon="stop" label={`Stop ${server.name}`} disabled={!server.available || !["ready", "installing", "starting"].includes(server.state)} onClick={() => void control(server.id, "stop")} />
            </div>
          </div>
          {server.service?.state === "ready" && <small className="muted">{Object.keys(server.service.effective(o.workbench.activePath())).filter(key => key.endsWith("Provider") && server.service!.effective(o.workbench.activePath())[key]).map(key => key.replace(/Provider$/, "")).join(" · ")}</small>}
          {!!server.service?.output.length && <details><summary>Server output</summary><pre style={{ whiteSpace: "pre-wrap", maxHeight: 160, overflow: "auto" }}>{server.service.output.join("")}</pre></details>}
          {server.error && <p className="lsp-server-error">{server.error}</p>}
        </section>;
      })}</div>
      <TooltipLayer rootRef={popup} escapeBubbles />
    </div>}
  </>;
}
