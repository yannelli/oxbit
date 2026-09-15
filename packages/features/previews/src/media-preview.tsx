import { useEffect, useState } from "react";
import type { FeatureOptions } from "@oxbit/sdk";
import { EmptyState, Icon, IconButton, translate as tr } from "@oxbit/ui";

export const audioTypes: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  wave: "audio/wav",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg; codecs=opus",
  aif: "audio/aiff",
  aiff: "audio/aiff",
  weba: "audio/webm",
};

export function createMediaPreview(o: FeatureOptions, kind: "pdf" | "audio") {
  return function MediaPreview({ path }: { path: string }) {
    const [source, setSource] = useState<{ url: string; bytes: number }>();
    const [error, setError] = useState("");
    const [revision, setRevision] = useState(0);
    const name = path.split("/").pop() || path;
    const type =
      kind === "pdf"
        ? "application/pdf"
        : audioTypes[name.split(".").pop()!.toLowerCase()];
    const desktop = o.kernel.commands
      .list()
      .find((command) => command.id === "desktop.reveal");
    const reveal =
      desktop &&
      o.kernel.contributions
        .list("menu")
        .some((item) => item.id === "desktop.reveal.explorer");

    useEffect(() => {
      const controller = new AbortController();
      let url = "";
      setSource(undefined);
      setError("");
      void (async () => {
        if (!o.filesystem.readBytes)
          throw new Error(tr("This workspace cannot read media files"));
        const bytes = await o.filesystem.readBytes(path, controller.signal);
        if (controller.signal.aborted) return;
        if (
          kind === "pdf" &&
          !new TextDecoder().decode(bytes.subarray(0, 1024)).includes("%PDF-")
        )
          throw new Error(tr("This file is not a PDF document."));
        url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
        setSource({ url, bytes: bytes.byteLength });
      })().catch((failure: unknown) => {
        if (!controller.signal.aborted)
          setError(
            failure instanceof Error ? failure.message : String(failure),
          );
      });
      return () => {
        controller.abort();
        if (url) URL.revokeObjectURL(url);
      };
    }, [path, type, revision]);

    useEffect(() => {
      const watch = o.filesystem.watch((change) => {
        if (change.path === path) setRevision((value) => value + 1);
      });
      return () => watch.dispose();
    }, [path]);

    return (
      <div className="media-document">
        <div className="preview-toolbar">
          <span className="truncate" title={path}>
            {name}
          </span>
          <span className="push" />
          {reveal && (
            <button
              className="button"
              onClick={() =>
                void o.kernel.commands
                  .execute("desktop.reveal", { path })
                  .catch((failure: unknown) =>
                    o.workbench.notify(String(failure), "error"),
                  )
              }
            >
              {tr(desktop.title)}
            </button>
          )}
          {source && !desktop && (
            <a className="button" href={source.url} download={name}>
              {tr("Download")}
            </a>
          )}
          <IconButton
            icon="refresh"
            label="Reload preview"
            onClick={() => setRevision((value) => value + 1)}
          />
        </div>
        {error ? (
          <EmptyState
            title={tr(kind === "pdf" ? "PDF unavailable" : "Audio unavailable")}
          >
            <p role="alert">{error}</p>
            <button
              className="button"
              onClick={() => setRevision((value) => value + 1)}
            >
              {tr("Retry")}
            </button>
          </EmptyState>
        ) : !source ? (
          <p className="muted" role="status">
            {tr("Loading preview…")}
          </p>
        ) : kind === "pdf" ? (
          <>
            <iframe
              className="pdf-preview"
              title={tr("PDF preview")}
              src={source.url}
            />
            {!desktop && (
              <p className="media-hint">
                {tr(
                  "If the PDF does not display, download it to open in your PDF reader.",
                )}
              </p>
            )}
          </>
        ) : (
          <div className="audio-preview">
            <Icon name="play" size={48} />
            <h2>{name}</h2>
            <p className="muted">{`${(source.bytes / 1024 / 1024).toFixed(2)} MB`}</p>
            <audio
              key={source.url}
              controls
              preload="metadata"
              src={source.url}
              aria-label={name}
              onError={() =>
                setError(
                  tr(
                    "This audio file is damaged or its codec is not supported by this device.",
                  ),
                )
              }
            />
          </div>
        )}
      </div>
    );
  };
}
