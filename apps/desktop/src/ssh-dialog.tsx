import { useState } from "react";
import { Dialog } from "@oxbit/ui";

export function sshWorkspaceUri(host: string, remotePath: string, port = "") {
  host = host.trim();
  remotePath = remotePath.trim();
  port = port.trim();
  if (
    !/^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*@)?(?:[A-Za-z0-9_][A-Za-z0-9_.-]*|\[[a-fA-F0-9:]+\])$/.test(
      host,
    )
  )
    throw new Error("Enter an SSH config alias or [user@]hostname.");
  if (port && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535))
    throw new Error("Port must be between 1 and 65535.");
  if (remotePath === "~") remotePath = "/~";
  else if (remotePath.startsWith("~/")) remotePath = "/" + remotePath;
  if (!remotePath.startsWith("/") || /[\x00-\x1f\x7f]/.test(remotePath))
    throw new Error(
      "Enter an absolute remote path or a path beginning with ~/.",
    );
  return `ssh://${host}${port ? ":" + Number(port) : ""}${remotePath.split("/").map(encodeURIComponent).join("/")}`;
}

export function SshDialog({
  onClose,
  onConnect,
}: {
  onClose: () => void;
  onConnect: (target: string) => Promise<void>;
}) {
  const [host, setHost] = useState("");
  const [remotePath, setRemotePath] = useState("~/");
  const [port, setPort] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      title="Connect over SSH"
      onClose={onClose}
      initialFocus=".ssh-form input"
    >
      <form
        className="ssh-form"
        onSubmit={(event) => {
          event.preventDefault();
          setError("");
          try {
            const uri = sshWorkspaceUri(host, remotePath, port);
            setBusy(true);
            void onConnect(uri)
              .catch((error) => setError(String(error)))
              .finally(() => setBusy(false));
          } catch (error) {
            setError((error as Error).message);
          }
        }}
      >
        <p>
          Open files and run developer tools on a remote machine. Oxbit installs
          its runtime automatically using your SSH connection.
        </p>
        <label>
          SSH host
          <input
            required
            placeholder="user@server or SSH config alias"
            value={host}
            onChange={(event) => {
              setError("");
              setHost(event.target.value);
            }}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <label>
          Remote folder or file
          <input
            required
            placeholder="~/projects/my-app"
            value={remotePath}
            onChange={(event) => {
              setError("");
              setRemotePath(event.target.value);
            }}
            spellCheck={false}
          />
        </label>
        <label>
          Port (optional)
          <input
            inputMode="numeric"
            placeholder="From SSH config, or 22"
            value={port}
            onChange={(event) => {
              setError("");
              setPort(event.target.value);
            }}
          />
        </label>
        <p>
          Uses your SSH config and keys. Connect once in a terminal to verify a
          new host. Supports Linux x64 and macOS Apple Silicon.
        </p>
        {error && <p role="alert">{error}</p>}
        <div className="dialog-actions">
          <button className="button" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" type="submit" disabled={busy}>
            {busy ? "Opening…" : "Connect"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
