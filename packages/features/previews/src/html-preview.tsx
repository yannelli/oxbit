import React, { useEffect, useRef, useState } from "react";
import type { FeatureOptions } from "@oxbit/sdk";
import { IconButton, translate as tr } from "@oxbit/ui";
import { isHtmlPath, prepareHtmlPreview } from "./html.js";
import { resolvePreviewLink, type PreviewResourceTrust } from "./policy.js";
import { PreviewResourceControl } from "./resource-trust.js";

export function createHtmlPreview(o: FeatureOptions) {
  return function HtmlPreview({ path }: { path: string }) {
    const [history, setHistory] = useState([path]);
    const current = history[history.length - 1]!;
    const [revision, setRevision] = useState(0);
    const [trust, setTrust] = useState<PreviewResourceTrust>("local");
    const [preview, setPreview] = useState<Awaited<ReturnType<typeof prepareHtmlPreview>>>();
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(true);
    const dependencies = useRef(new Set([current]));
    const scroll = useRef({ path: current, top: 0 });
    const frame = useRef<HTMLIFrameElement>(null);
    const anchor = useRef<string | undefined>(undefined);

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
        filesystem: o.filesystem,
        signal: controller.signal,
        dependencies: dependencies.current,
        readText: async file => {
          const doc = o.documents.get(file);
          if (doc?.state === "missing") throw new Error(tr("File no longer exists"));
          return doc ? doc.text.toString() : (await o.filesystem.read(file)).text;
        },
      }).then(result => {
        if (!controller.signal.aborted) { setPreview(result); setLoading(false); }
      }).catch((failure: unknown) => {
        if (!controller.signal.aborted) {
          setError(failure instanceof Error ? failure.message : String(failure));
          setLoading(false);
        }
      });
      return () => controller.abort();
    }, [current, revision, trust]);

    useEffect(() => {
      const restore = () => {
        frame.current?.contentWindow?.postMessage({ type: "oxbit.preview.restore", top: scroll.current.top, anchor: anchor.current }, "*");
        anchor.current = undefined;
      };
      const message = (event: MessageEvent) => {
        if (event.source !== frame.current?.contentWindow || event.origin !== "null" || event.data?.path !== current) return;
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
        <IconButton icon="chevR" className="icon-button html-preview-back" label={tr("Back in HTML preview")} disabled={history.length < 2}
          onClick={() => setHistory(items => items.slice(0, -1))} />
        <span className="truncate" title={current}>{current}</span>
        <IconButton icon="refresh" label={tr("Refresh HTML preview")} onClick={() => setRevision(value => value + 1)} />
        <button className="button" onClick={openSource}>{tr("Open source")}</button>
      </div>
      <PreviewResourceControl trust={trust} onChange={setTrust} />
      {loading && <div className="html-preview-message" role="status">{tr("Loading preview…")}</div>}
      {error && <div className="html-preview-message error-text" role="alert">{error}</div>}
      {!!preview?.warnings.length && <details className="html-preview-message">
        <summary>{tr("Some preview resources could not be loaded")}</summary>
        {preview.warnings.map(warning => <p key={warning}>{tr(warning)}</p>)}
      </details>}
      {preview?.scripts && <div className="html-preview-message">{tr("HTML & CSS preview · JavaScript is disabled")}</div>}
      {preview && preview.trust === trust && !error && <iframe ref={frame} className="html-preview-frame" title={tr("HTML preview")}
        sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={preview.html} />}
    </div>;
  };
}
