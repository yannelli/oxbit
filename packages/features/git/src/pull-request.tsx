import { useEffect, useRef, useState } from "react";
import { Dialog, Icon, translate as tr } from "@oxbit/ui";

export function PullRequestDialog({
  title: initialTitle,
  aiUnavailable,
  generate,
  create,
  onClose,
}: {
  title: string;
  /** Why AI text generation is off, or undefined when it is available. */
  aiUnavailable?: string;
  generate(signal: AbortSignal): Promise<{ title: string; body: string }>;
  create(title: string, body: string, progress: (message: string) => void): Promise<string>;
  onClose(): void;
}) {
  const [title, setTitle] = useState(initialTitle);
  const [body, setBody] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [url, setUrl] = useState("");
  const [creating, setCreating] = useState(false);
  const [generating, setGenerating] = useState<AbortController>();
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  useEffect(() => () => generating?.abort(), [generating]);
  const fail = (failure: unknown) => {
    if (!mounted.current) return;
    setError(failure instanceof Error ? failure.message : String(failure));
  };
  const fill = () => {
    if (generating) {
      generating.abort();
      setGenerating(undefined);
      return;
    }
    const controller = new AbortController();
    setError("");
    setGenerating(controller);
    void generate(controller.signal)
      .then((text) => {
        if (controller.signal.aborted || !mounted.current) return;
        setTitle(text.title);
        setBody(text.body);
      }, (failure: unknown) => {
        if (!controller.signal.aborted) fail(failure);
      })
      .finally(() => {
        if (mounted.current) setGenerating((current) => (current === controller ? undefined : current));
      });
  };
  const submit = () => {
    setError("");
    setCreating(true);
    void create(title.trim(), body, setStatus)
      .then((created) => mounted.current && setUrl(created), fail)
      .finally(() => {
        if (!mounted.current) return;
        setCreating(false);
        setStatus("");
      });
  };
  const busy = creating || !!generating;
  return (
    <Dialog title={tr("Create Draft Pull Request")} className="scm-pr-dialog" onClose={creating ? () => {} : onClose}>
      {url ? (
        <>
          <p role="status">{tr("Draft pull request created")}</p>
          <p className="scm-pr-url">
            <code>{url}</code>
          </p>
          <div className="dialog-actions">
            <button className="button" onClick={onClose}>
              {tr("Close")}
            </button>
            <button className="button primary" onClick={() => window.open(url, "_blank", "noopener,noreferrer")}>
              {tr("Open")}
            </button>
          </div>
        </>
      ) : (
        <>
          <label className="scm-field">
            <span>{tr("Pull request title")}</span>
            <input value={title} disabled={busy} onChange={(event) => setTitle(event.target.value)} />
          </label>
          <label className="scm-field">
            <span>{tr("Pull request description")}</span>
            <textarea rows={8} value={body} disabled={busy} onChange={(event) => setBody(event.target.value)} />
          </label>
          {status && <p role="status">{status}</p>}
          {error && (
            <p role="alert" className="error-text">
              {error}
            </p>
          )}
          <div className="dialog-actions">
            <button
              className="button scm-pr-generate"
              disabled={creating}
              aria-disabled={!generating && !!aiUnavailable ? true : undefined}
              data-tooltip={aiUnavailable}
              aria-busy={!!generating}
              onClick={() => (generating || !aiUnavailable) && fill()}
            >
              <Icon name={generating ? "stop" : "agent"} />
              {generating ? tr("Stop generating") : tr("Generate with AI")}
            </button>
            <button className="button" disabled={creating} onClick={onClose}>
              {tr("Cancel")}
            </button>
            <button className="button primary" disabled={busy || !title.trim()} onClick={submit}>
              {tr("Create Draft Pull Request")}
            </button>
          </div>
        </>
      )}
    </Dialog>
  );
}
