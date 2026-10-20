import React, { useEffect, useRef, useState } from "react";
import type { FeatureOptions } from "@oxbit/sdk";
import { Dialog, IconButton, translate as tr } from "@oxbit/ui";
import { isHtmlPath, prepareHtmlPreview } from "./html.js";
import { resolvePreviewLink, type PreviewResourceTrust } from "./policy.js";
import { PreviewResourceControl, PreviewScriptControl } from "./resource-trust.js";

let serial = 0;
/** Preview roots whose JavaScript the user turned on or off this session. */
const scriptChoices = new Map<string, boolean>();

/** A page served without the app's script policy; desktop and iOS register the oxbit-preview scheme. */
function previewShellUrl() {
  const tauri = (globalThis as { __TAURI_INTERNALS__?: { convertFileSrc(path: string, protocol: string): string } }).__TAURI_INTERNALS__;
  return tauri ? tauri.convertFileSrc("preview-shell.html", "oxbit-preview") : new URL("preview-shell.html", document.baseURI).href;
}

export function createHtmlPreview(o: FeatureOptions) {
  return function HtmlPreview({ path }: { path: string }) {
    const [history, setHistory] = useState([path]);
    const current = history[history.length - 1]!;
    const [revision, setRevision] = useState(0);
    const [trust, setTrust] = useState<PreviewResourceTrust>("local");
    const [preview, setPreview] = useState<Awaited<ReturnType<typeof prepareHtmlPreview>> & { serial: number }>();
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(true);
    const [optionsOpen, setOptionsOpen] = useState(false);
    const dependencies = useRef(new Set([current]));
    const scroll = useRef({ path: current, top: 0 });
    const frame = useRef<HTMLIFrameElement>(null);
    const anchor = useRef<string | undefined>(undefined);
    const shellDocument = useRef<string | undefined>(undefined);
    // A trusted runtime workspace runs scripts; the iOS app and untrusted workspaces ask first.
    const trusted = () => o.kernel.context.get("trusted") === true && o.kernel.context.get("iosApp") !== true;
    const [autoRun, setAutoRun] = useState(trusted);
    const [choice, setChoice] = useState(() => scriptChoices.get(path));
    const scripts = choice ?? autoRun;
    const chooseScripts = (value: boolean) => { scriptChoices.set(path, value); setChoice(value); };
    useEffect(() => o.kernel.context.subscribe(() => setAutoRun(trusted())), []);

    useEffect(() => {
      let timer: ReturnType<typeof setTimeout>;
      const refresh = () => {
        clearTimeout(timer);
        timer = setTimeout(() => setRevision(value => value + 1), 200);
      };
      const changes = o.kernel.events.on("document.change", ({ id }) => {
        if ([...dependencies.current].some(file => o.documents.get(file)?.id === id)) refresh();
      });
      const files = o.filesystem.watch(change => {
        if (dependencies.current.has(change.path)) refresh();
      });
      return () => { clearTimeout(timer); changes.dispose(); files.dispose(); };
    }, []);

    useEffect(() => {
      const controller = new AbortController();
      dependencies.current = new Set([current]);
      if (scroll.current.path !== current) scroll.current = { path: current, top: 0 };
      setLoading(true);
      setError("");
      void prepareHtmlPreview({
        path: current,
        trust,
        scripts,
        filesystem: o.filesystem,
        signal: controller.signal,
        dependencies: dependencies.current,
        readText: async file => {
          const doc = o.documents.get(file);
          if (doc?.state === "missing") throw new Error(tr("File no longer exists"));
          return doc ? doc.text.toString() : (await o.filesystem.read(file)).text;
        },
      }).then(result => {
        if (controller.signal.aborted) return;
        shellDocument.current = result.running ? result.html : undefined;
        setPreview({ ...result, serial: ++serial });
        setLoading(false);
      }).catch((failure: unknown) => {
        if (!controller.signal.aborted) {
          setError(failure instanceof Error ? failure.message : String(failure));
          setLoading(false);
        }
      });
      return () => controller.abort();
    }, [current, revision, trust, scripts]);

    useEffect(() => {
      const restore = () => {
        frame.current?.contentWindow?.postMessage({ type: "oxbit.preview.restore", top: scroll.current.top, anchor: anchor.current }, "*");
        anchor.current = undefined;
      };
      const message = (event: MessageEvent) => {
        if (event.source !== frame.current?.contentWindow || event.origin !== "null") return;
        if (event.data?.type === "oxbit.preview.shell" && shellDocument.current !== undefined)
          frame.current.contentWindow!.postMessage({ type: "oxbit.preview.document", html: shellDocument.current }, "*");
        if (event.data?.path !== current) return;
        if (event.data.type === "oxbit.preview.ready") restore();
        if (event.data.type === "oxbit.preview.scroll" && Number.isFinite(event.data.top))
          scroll.current.top = Math.max(0, event.data.top);
        if (event.data.type !== "oxbit.preview.link" || typeof event.data.href !== "string") return;
        const target = resolvePreviewLink(current, event.data.href);
        if (target.kind === "anchor" || (target.kind === "file" && target.path === current && target.anchor)) {
          anchor.current = target.kind === "anchor" ? target.id : target.anchor;
          restore();
        } else if (target.kind === "file" && isHtmlPath(target.path)) {
          anchor.current = target.anchor;
          setHistory(items => [...items, target.path]);
        } else if (target.kind === "file")
          void Promise.resolve(o.workbench.openFile(target.path)).catch((error: unknown) => o.workbench.notify(String(error), "error"));
        else if (target.kind === "external") window.open(target.url, "_blank", "noopener,noreferrer");
        else o.workbench.notify(target.reason, "warning");
      };
      window.addEventListener("message", message);
      return () => window.removeEventListener("message", message);
    }, [current]);

    const openSource = () => {
      void Promise.resolve(o.workbench.openFile(current, { preview: false }))
        .catch((failure: unknown) => o.workbench.notify(String(failure), "error"));
    };

    return <div className="html-document" aria-busy={loading}>
      <div className="preview-toolbar html-preview-toolbar">
        {history.length > 1 && <IconButton icon="chevR" className="icon-button html-preview-back" label={tr("Back in HTML preview")}
          onClick={() => setHistory(items => items.slice(0, -1))} />}
        <span className="truncate" title={current} role="status">{loading ? tr("Loading preview…") : current.split("/").pop()}</span>
        <IconButton icon="refresh" label={tr("Refresh HTML preview")} onClick={() => setRevision(value => value + 1)} />
        <IconButton icon="pencil" label={tr("Open source")} onClick={openSource} />
        <IconButton icon="gear" className="icon-button html-preview-options-trigger" label={tr("Preview options")}
          data-warning={!!preview?.warnings.length} aria-haspopup="dialog" aria-expanded={optionsOpen}
          onClick={event => { event.currentTarget.focus({ preventScroll: true }); setOptionsOpen(true); }} />
      </div>
      {error && <div className="html-preview-message error-text" role="alert">{error}</div>}
      {optionsOpen && <Dialog title={tr("Preview options")} className="html-preview-options" onClose={() => setOptionsOpen(false)}>
        {preview?.scripts && <PreviewScriptControl running={scripts} onChange={chooseScripts} />}
        <PreviewResourceControl trust={trust} onChange={setTrust} scripts={preview?.scripts ? scripts : false} />
        {!!preview?.warnings.length && <details className="html-preview-warnings">
          <summary>{tr("Some preview resources could not be loaded")}</summary>
          {preview.warnings.map(warning => <p key={warning}>{tr(warning)}</p>)}
        </details>}
      </Dialog>}
      {preview?.scripts && !preview.running && !error && <div className="html-preview-scripts" role="note">
        <span>{tr("This page has JavaScript, which is off. Scripts you run can load content from the internet and send data to it.")}</span>
        <button type="button" className="button" onClick={() => chooseScripts(true)}>{tr("Run JavaScript")}</button>
      </div>}
      {preview && preview.trust === trust && !error && (preview.running
        ? <iframe ref={frame} key={preview.serial} className="html-preview-frame" title={tr("HTML preview")}
          sandbox="allow-scripts allow-forms allow-modals" referrerPolicy="no-referrer" src={previewShellUrl()} />
        : <iframe ref={frame} className="html-preview-frame" title={tr("HTML preview")}
          sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={preview.html} />)}
    </div>;
  };
}
