import React, { useCallback, useEffect, useRef, useState } from "react";
import type { Extension, FeatureOptions } from "@oxbit/sdk";
import { EmptyState, IconButton, translate as tr } from "@oxbit/ui";
import {
  fitScale,
  formatBytes,
  formatZoom,
  imageExtensions,
  isVector,
  mimeForPath,
  nextZoom,
  type Size,
} from "./media.js";
export * from "./media.js";

export const viewId = "oxbit.images.view";

export function createFeature(o: FeatureOptions): Extension {
  // The tab id is the path, so the view has to go before a text tab can take it.
  const openSource = async (path: string) => {
    o.workbench.closeView(path);
    await o.workbench.openFile(path, { text: true, preview: false });
  };

  function ImageViewer({ path }: { path: string }) {
    const [source, setSource] = useState<{ url: string; bytes: number }>();
    const [error, setError] = useState("");
    const [natural, setNatural] = useState<Size>();
    const [zoom, setZoom] = useState<number | "fit">("fit");
    const [viewport, setViewport] = useState<Size>({ width: 0, height: 0 });
    const [revision, setRevision] = useState(0);
    const canvas = useRef<HTMLDivElement>(null);

    useEffect(() => {
      const controller = new AbortController();
      let url = "";
      setSource(undefined);
      setError("");
      setNatural(undefined);
      void (async () => {
        if (!o.filesystem.readBytes)
          throw new Error(tr("This workspace cannot read image files"));
        const bytes = await o.filesystem.readBytes(path, controller.signal);
        if (controller.signal.aborted) return;
        url = URL.createObjectURL(
          new Blob([bytes as BlobPart], { type: mimeForPath(path) }),
        );
        setSource({ url, bytes: bytes.byteLength });
      })().catch((failure: unknown) => {
        if (controller.signal.aborted) return;
        setError(failure instanceof Error ? failure.message : String(failure));
      });
      return () => {
        controller.abort();
        if (url) URL.revokeObjectURL(url);
      };
    }, [path, revision]);

    useEffect(() => {
      const watch = o.filesystem.watch((change) => {
        if (change.path === path && change.kind === "changed")
          setRevision((value) => value + 1);
      });
      return () => watch.dispose();
    }, [path]);

    useEffect(() => {
      const element = canvas.current;
      if (!element || typeof ResizeObserver === "undefined") return;
      const observer = new ResizeObserver(([entry]) =>
        setViewport({
          width: entry!.contentRect.width,
          height: entry!.contentRect.height,
        }),
      );
      observer.observe(element);
      return () => observer.disconnect();
    }, []);

    const scale = natural
      ? zoom === "fit"
        ? fitScale(natural, viewport)
        : zoom
      : 1;
    const step = useCallback(
      (direction: 1 | -1) => setZoom(nextZoom(scale, direction)),
      [scale],
    );

    const meta = [
      natural && `${natural.width} × ${natural.height}`,
      source && formatBytes(source.bytes),
    ].filter(Boolean);

    return (
      <div className="image-document">
        <div className="preview-toolbar">
          <span className="image-meta">
            <span className="truncate">{path}</span>
            {meta.length > 0 && <span>{meta.join("  ·  ")}</span>}
          </span>
          <span className="image-actions">
            <IconButton
              icon="minus"
              label="Zoom out"
              disabled={!natural}
              onClick={() => step(-1)}
            />
            <button
              className="text-button"
              disabled={!natural}
              onClick={() => setZoom(zoom === 1 ? "fit" : 1)}
            >
              {natural ? formatZoom(scale) : "—"}
            </button>
            <IconButton
              icon="plus"
              label="Zoom in"
              disabled={!natural}
              onClick={() => step(1)}
            />
            <IconButton
              icon="focus"
              label="Fit to window"
              disabled={!natural}
              aria-pressed={zoom === "fit"}
              onClick={() => setZoom("fit")}
            />
            <IconButton
              icon="refresh"
              label="Reload image"
              onClick={() => setRevision((value) => value + 1)}
            />
            {isVector(path) && (
              <button
                className="button"
                onClick={() => void openSource(path)}
              >
                {tr("Open source")}
              </button>
            )}
          </span>
        </div>
        <div
          ref={canvas}
          className={`image-canvas${scale >= 2 && !isVector(path) ? " pixelated" : ""}`}
          tabIndex={0}
          role="group"
          aria-label={tr("Image preview")}
          onKeyDown={(event) => {
            if (event.metaKey || event.ctrlKey || event.altKey) return;
            if (event.key === "+" || event.key === "=") step(1);
            else if (event.key === "-") step(-1);
            else if (event.key === "0") setZoom(1);
            else if (event.key === "9") setZoom("fit");
            else return;
            event.preventDefault();
          }}
        >
          {error ? (
            <EmptyState title={tr("Image unavailable")}>
              <p>{path}</p>
              <p role="alert">{error}</p>
              <button
                className="button"
                onClick={() => setRevision((value) => value + 1)}
              >
                {tr("Retry")}
              </button>
              <button className="button" onClick={() => void openSource(path)}>
                {tr("Open source")}
              </button>
            </EmptyState>
          ) : (
            source && (
              <img
                className="image-frame"
                src={source.url}
                alt={path.split("/").pop()}
                decoding="async"
                draggable={false}
                onLoad={(event) => {
                  const image = event.currentTarget;
                  // An SVG with only a viewBox reports no intrinsic size; let the browser size it.
                  if (image.naturalWidth > 0 && image.naturalHeight > 0)
                    setNatural({
                      width: image.naturalWidth,
                      height: image.naturalHeight,
                    });
                }}
                onError={() =>
                  setError(tr("This file is not a supported image"))
                }
                {...(natural
                  ? {
                      width: Math.max(1, Math.round(natural.width * scale)),
                      height: Math.max(1, Math.round(natural.height * scale)),
                    }
                  : {})}
              />
            )
          )}
        </div>
      </div>
    );
  }

  return {
    manifest: {
      manifestVersion: 1,
      id: "oxbit.images",
      name: "Image Viewer",
      version: "1.0.0",
      sdk: "^1.0.0",
      environments: ["browser", "embedded"],
      activation: ["*"],
      capabilities: ["filesystem.read"],
      description:
        "Opens PNG, JPEG, GIF, WebP, AVIF, BMP, ICO and SVG files without decoding them as text.",
    },
    activate(ctx) {
      ctx.own(
        ctx.contributions.register({
          id: viewId,
          kind: "documentView",
          title: "Image Viewer",
          component: ImageViewer,
          data: { binary: true, extensions: imageExtensions },
        }),
      );
      ctx.own(
        ctx.commands.register({
          id: "image.openSource",
          title: "Open Image as Text",
          category: "Image",
          when: "binaryDocument",
          run: () => {
            const path = o.workbench.activePath();
            if (!path) throw new Error("Open an image first");
            return openSource(path);
          },
        }),
      );
    },
  };
}
