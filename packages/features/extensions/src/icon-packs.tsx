import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { IconPackPreview, IconThemeKind, IconThemes, Kernel } from "@oxbit/sdk";
import type { WorkbenchController } from "@oxbit/workbench";
import { Dialog, IconImage, IconThemeSelect } from "@oxbit/ui";
export function IconPackManager({ kernel, workbench, selectKind, selectRequest = 0, importRequest = 0 }: { kernel: Kernel; workbench: WorkbenchController; selectKind?: IconThemeKind; selectRequest?: number; importRequest?: number }) {
  const service = kernel.services.get<IconThemes>('iconThemes');
  useSyncExternalStore(service.subscribe, service.snapshot);
  useSyncExternalStore(workbench.subscribe, workbench.snapshot);
  const [preview, setPreview] = useState<IconPackPreview>();
  const [busy, setBusy] = useState(false), [status, setStatus] = useState('');
  const replacement = useRef<string>(undefined);
  const abort = useRef<AbortController>(undefined), input = useRef<HTMLInputElement>(null);
  const previewRef = useRef<IconPackPreview>(undefined), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; abort.current?.abort(); previewRef.current?.dispose(); }; }, []);
  useEffect(() => { if (importRequest) input.current?.click(); }, [importRequest]);
  const closePreview = () => { previewRef.current?.dispose(); previewRef.current = undefined; setPreview(undefined); };
  const perform = async (action: () => Promise<void>) => {
    setBusy(true); setStatus('');
    try { await action(); }
    catch (error) { if (mounted.current) setStatus(error instanceof Error ? error.message : String(error)); }
    finally { if (mounted.current) setBusy(false); }
  };
  return <div className="settings-screen icon-packs"><div className="settings-heading"><h1>Icon Packs</h1>
    <p>Import a local ZIP or VSIX. Installation keeps your current selections.</p>
    <div className="toolbar" style={{ flexWrap: 'wrap', gap: 8 }}>
      <button className="button" disabled={busy} onClick={() => { replacement.current = undefined; input.current?.click(); }}>Import Icon Pack…</button>
      <input ref={input} hidden type="file" accept=".zip,.vsix" aria-label="Import icon pack archive" onChange={event => {
        const file = event.target.files?.[0]; event.target.value = '';
        if (file) void perform(async () => {
          abort.current?.abort(); abort.current = new AbortController();
          const next = await service.preview(file, file.name, abort.current.signal);
          if (!mounted.current) { next.dispose(); return; }
          if (replacement.current && next.id !== replacement.current) { next.dispose(); throw new Error(`Choose a replacement for ${replacement.current}, or use Import Icon Pack to install a different pack.`); }
          previewRef.current?.dispose(); previewRef.current = next; setPreview(next);
        });
      }} />
      {busy && <button className="button" onClick={() => abort.current?.abort()}>Cancel import</button>}
      <IconThemeSelect kernel={kernel} kind="fileIconTheme" openRequest={selectKind === 'fileIconTheme' ? selectRequest : 0} />
      <IconThemeSelect kernel={kernel} kind="productIconTheme" openRequest={selectKind === 'productIconTheme' ? selectRequest : 0} />
    </div><p role="status">{busy ? 'Validating icon pack…' : status}</p>
  </div><div className="settings-list">
    {!service.list().length && <p className="padded muted">No icon packs installed.</p>}
    {service.list().map(pack => <section className="setting-row" key={pack.id}><h2>{pack.label}</h2><p>{pack.publisher} · {pack.version} · {pack.license ?? 'License not declared'} · {pack.enabled ? 'Enabled' : 'Disabled'}</p><p>{pack.description}</p><code>{pack.id}</code>
      <div className="toolbar" style={{ flexWrap: 'wrap', gap: 8 }}>{pack.themes.map(theme => <button className="button" key={theme.kind + theme.id} disabled={!pack.enabled} onClick={() => kernel.configuration.set(theme.kind === 'fileIconTheme' ? 'workbench.iconTheme' : 'workbench.productIconTheme', theme.id)}>Apply {theme.label} ({theme.kind === 'fileIconTheme' ? 'files' : 'controls'})</button>)}
        <button className="button" disabled={busy} onClick={() => void perform(() => service.enable(pack.id, !pack.enabled))}>{pack.enabled ? 'Disable' : 'Enable'} {pack.label}</button>
        <button className="button" disabled={busy} onClick={() => { replacement.current = pack.id; input.current?.click(); }}>Replace {pack.label}…</button>
        <button className="button" disabled={busy} onClick={() => void perform(() => service.remove(pack.id))}>Uninstall {pack.label}</button>
      </div>
      <details><summary>Preview and compatibility</summary><div className="toolbar" aria-label={`Sample icons from ${pack.label}`}>{service.samples(pack.id).map((asset, i) => <IconImage key={i} asset={asset} size={24} />)}</div><p>Themes: {pack.themes.map(t => t.label).join(', ')}</p><p>Apply a theme above to preview it in the workbench. Select Oxbit Default to restore the original icons.</p>{pack.warnings.map((warning, i) => <p key={i}>{warning}</p>)}</details>
    </section>)}
  </div>
  {preview && <Dialog className="icon-pack-review" title="Review Icon Pack" onClose={closePreview}><h2>{preview.label}</h2><p>{preview.publisher} · {preview.version} · {preview.license ?? 'License not declared'}</p><p>{preview.description}</p><p>{preview.id}</p>
    <ul>{preview.themes.map(t => <li key={t.kind + t.id}>{t.label} — {t.kind === 'fileIconTheme' ? 'File and folder icons' : 'Application controls'}</li>)}</ul>
    <div className="toolbar" aria-label="Sample icons">{preview.samples.map((asset, i) => <IconImage key={i} asset={asset} size={24} />)}</div>
    {preview.warnings.map((warning, i) => <p key={i}>{warning}</p>)}
    <p>Only declarative theme data, referenced assets, attribution and licenses are installed. Extension code is never executed.</p>
    <div className="toolbar"><button className="button primary" disabled={busy} onClick={() => void perform(async () => { await service.install(preview); closePreview(); setStatus('Icon pack installed. Choose a theme to apply it.'); })}>{service.list().some(p => p.id === preview.id) ? 'Replace Icon Pack' : 'Install Icon Pack'}</button><button className="button" disabled={busy} onClick={closePreview}>Cancel</button></div>
    {status && <p role="alert">{status}</p>}
  </Dialog>}
  </div>;
}
