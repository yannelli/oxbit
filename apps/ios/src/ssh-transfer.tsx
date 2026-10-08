import { useEffect, useRef, useState } from "react";
import { native, ssh, type SshFileSystem, type TransferProgress } from "@oxbit/host-ios";
import { Dialog } from "@oxbit/ui";
import { describe } from "./ssh-settings.js";

export type TransferRequest =
  | { kind: "upload"; filesystem: SshFileSystem; directory: string }
  | { kind: "download"; filesystem: SshFileSystem; path: string };

export function formatBytes(bytes: number) {
  const units = ["bytes", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return unit ? `${value.toFixed(1)} ${units[unit]}` : `${bytes} bytes`;
}

function cancelled(failure: unknown) {
  return (failure as { code?: string }).code === "CANCELLED" || /cancelled/i.test(describe(failure));
}

/** A dismissed Files picker resolves to nothing so the dialog closes quietly. */
function picked<T>(choice: Promise<T>) {
  return choice.catch(failure => {
    if (cancelled(failure)) return undefined;
    throw failure;
  });
}

async function run(request: TransferRequest, transferId: string) {
  const id = request.filesystem.id;
  if (request.kind === "upload") {
    const files = await picked(ssh.pickFiles(true));
    if (!files?.length) return;
    const summary = await ssh.upload(id, transferId, request.directory, files.map(file => file.path));
    return `Uploaded ${summary.files} ${summary.files === 1 ? "file" : "files"} (${formatBytes(summary.bytes)}) to ${request.directory || request.filesystem.name}.`;
  }
  const folder = await picked(native.pickFolder());
  if (!folder) return;
  try {
    const summary = await ssh.download(id, transferId, request.path, folder.path);
    return `Downloaded ${summary.files} ${summary.files === 1 ? "file" : "files"} (${formatBytes(summary.bytes)}) to ${folder.name}.`;
  } finally {
    await native.closeFolder(folder.id).catch(() => {});
    await native.forgetFolder(folder.id).catch(() => {});
  }
}

export function SshTransfer({ request, onDone, onClose }: { request: TransferRequest; onDone: () => void; onClose: () => void }) {
  const transferId = useRef(crypto.randomUUID());
  const started = useRef(false);
  const [progress, setProgress] = useState<TransferProgress>();
  const [running, setRunning] = useState(true);
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        unlisten = await ssh.onTransfer(transferId.current, setProgress);
        const message = await run(request, transferId.current);
        if (!message) return onClose();
        setResult(message);
        onDone();
      } catch (failure) {
        if (cancelled(failure)) setResult(request.kind === "upload" ? "Upload cancelled. Nothing was added." : "Download cancelled. Nothing was saved.");
        else setError(describe(failure));
      } finally {
        unlisten?.();
        setRunning(false);
      }
    })();
  }, [request, onDone, onClose]);
  const title = request.kind === "upload" ? "Upload to Server" : "Download to Device";
  const percent = progress?.total ? Math.min(100, Math.round((progress.transferred / progress.total) * 100)) : 0;
  return <Dialog title={title} onClose={() => { if (!running) onClose(); }}>
    <div className="runtime-form ssh-transfer">
      {running && !progress && <p role="status">{request.kind === "upload" ? "Choose files to upload…" : "Choose a folder on this device…"}</p>}
      {progress && <>
        <progress max={100} value={percent} aria-label={`${title} progress`} />
        <p className="small">{percent}% · {formatBytes(progress.transferred)} of {formatBytes(progress.total)}</p>
        <p className="small muted ssh-transfer-file">{progress.file}</p>
      </>}
      {result && <p role="status">{result}</p>}
      {error && <p className="error-text" role="alert">{error}</p>}
      <div className="dialog-actions">
        {running
          ? <button type="button" className="button" disabled={!progress} onClick={() => void ssh.cancelTransfer(transferId.current)}>Cancel Transfer</button>
          : <button type="button" className="button primary" onClick={onClose}>Done</button>}
      </div>
    </div>
  </Dialog>;
}
