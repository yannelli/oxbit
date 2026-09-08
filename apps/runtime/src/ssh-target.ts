export interface SshTarget {
  destination: string;
  path: string;
  port?: number;
}

/** A workspace URI, not a shell command. SSH aliases resolve through ~/.ssh/config. */
export function parseSshTarget(value: string): SshTarget {
  const match = /^ssh:\/\/([^/]+)(\/.*)$/.exec(value);
  if (!match || value.length > 8192 || /[\x00-\x1f\x7f]/.test(value))
    throw new Error("Use ssh://[user@]host[:port]/absolute/path or /~/path");
  const authority =
    /^(?:([A-Za-z0-9_][A-Za-z0-9_.-]*)@)?(\[[a-fA-F0-9:]+\]|[A-Za-z0-9_][A-Za-z0-9_.-]*)(?::([0-9]+))?$/.exec(
      match[1],
    );
  if (!authority)
    throw new Error("Invalid SSH host. Use a hostname or SSH config alias.");
  const port = authority[3] ? Number(authority[3]) : undefined;
  if (
    port !== undefined &&
    (!Number.isInteger(port) || port < 1 || port > 65535)
  )
    throw new Error("SSH port must be between 1 and 65535");
  let path: string;
  try {
    path = decodeURIComponent(match[2]);
  } catch {
    throw new Error("Invalid encoded remote path");
  }
  if (/[\x00-\x1f\x7f]/.test(path))
    throw new Error("Remote paths cannot contain control characters");
  return {
    destination: (authority[1] ? authority[1] + "@" : "") + authority[2],
    path,
    port,
  };
}

export const shellQuote = (value: string) =>
  "'" + value.replaceAll("'", "'\\''") + "'";

export function sshArguments(target: SshTarget, socket: string) {
  return [
    "-T",
    "-a",
    "-x",
    "-S",
    socket,
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ConnectTimeout=15",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    "-o",
    "ControlPersist=no",
    "-o",
    "ForkAfterAuthentication=no",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "PermitLocalCommand=no",
    "-o",
    "RemoteCommand=none",
    ...(target.port ? ["-p", String(target.port)] : []),
  ];
}

/** The archive is supplied by this app, authenticated by SSH, and verified before extraction. */
export function installScript(digest: string) {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("Invalid runtime digest");
  return `set -eu
umask 077
base="$HOME/.oxbit/remote/runtimes"
mkdir -p "$base"
stage=$(mktemp -d "$base/.install-XXXXXXXX")
lock=""
trap 'rm -rf "$stage"; [ -z "$lock" ] || rmdir "$lock" 2>/dev/null || true' EXIT
trap 'exit 1' HUP INT TERM
cat > "$stage/runtime.tar.gz"
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$stage/runtime.tar.gz")
else
  actual=$(shasum -a 256 "$stage/runtime.tar.gz")
fi
[ "\${actual%% *}" = '${digest}' ] || { echo 'Runtime checksum mismatch' >&2; exit 1; }
mkdir "$stage/runtime"
tar -xzf "$stage/runtime.tar.gz" -C "$stage/runtime"
"$stage/runtime/bin/node" --version >/dev/null
touch "$stage/runtime/.complete"
# Serialize only the atomic publish, after the slow transfer and extraction.
attempt=0
while ! mkdir "$base/${digest}.lock" 2>/dev/null; do
  if [ -f "$base/${digest}/.complete" ]; then exit 0; fi
  attempt=$((attempt + 1))
  [ "$attempt" -lt 30 ] || { echo 'Another runtime install is in progress; retry shortly.' >&2; exit 1; }
  sleep 1
done
lock="$base/${digest}.lock"
if [ ! -f "$base/${digest}/.complete" ]; then
  mv "$stage/runtime" "$base/${digest}"
fi
`;
}
