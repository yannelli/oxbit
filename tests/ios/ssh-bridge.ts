import type { Page } from "@playwright/test";

export interface SshSeed {
  hosts?: { id: string; label: string; hostname: string; port: number; username: string; auth: "key" | "password"; keyId?: string; passwordSaved: boolean }[];
  keys?: { id: string; name: string; algorithm: string; fingerprint: string; publicKey: string }[];
  known?: Record<string, { algorithm: string; fingerprint: string; added: number }[]>;
  /** Errors that `git.clone` returns in order before it succeeds. */
  clone?: ("SSH_KEY_REQUIRED" | "HOST_KEY_UNKNOWN" | "HOST_KEY_CHANGED")[];
  /** `ios_ssh_runtime_start` fails with this message after the install progress. */
  runtimeFailure?: string;
}

/** Where the mocked remote runtime listens; specs answer its WebSocket with `page.routeWebSocket`. */
export const RUNTIME_URL = "http://127.0.0.1:9399";

export const PRESENTED = { algorithm: "ssh-ed25519", fingerprint: "SHA256:qP8mY2tVt3rJ0q7dGm1xC5sWn9uL4kHf6aZ2bE8cR0o" };
export const SAVED = { algorithm: "ssh-ed25519", fingerprint: "SHA256:Lk3Vx9aQe2Tz7Wn1Rb5Hc8Ym4Uf0Jd6Gs2Po9Ki3Lm7", added: 1 };

/** Serves the SSH commands from memory. Transfers hold at 40% until `__sshMock.release()` or a cancel. */
export async function installSshBridge(page: Page, seed: SshSeed = {}) {
  await page.addInitScript(({ seed, presented, saved, runtimeUrl }) => {
    const encoder = new TextEncoder();
    const hosts = seed.hosts ?? [];
    const keys = seed.keys ?? [];
    const known = new Map(Object.entries(seed.known ?? {}));
    const connected = new Set<string>();
    const roots = new Map<string, string>();
    const files = new Map<string, string>([["README.md", "# Remote project\n"], ["src/main.ts", "export const remote = true;\n"]]);
    const directories = new Set(["src"]);
    const pending = new Map<string, { finish: () => void; cancel: () => void }>();
    const runtimes = new Set<string>();
    const starts: { hostId: string; path: string; root: string; workspaceKey: string }[] = [];
    let runtimeEmit: ((event: string, payload: unknown) => void) | undefined;
    const calls: string[] = [];
    // The server's folders, listed when a root opens at `/`.
    const server = new Set(["home", "home/dev", "home/dev/.cache", "home/dev/other", "home/dev/project", "home/dev/project/src", "srv", "srv/app"]);
    const serverFiles = new Set(["home/dev/notes.txt"]);
    const clone = [...(seed.clone ?? [])];
    const prompts = new Map<string, any>();
    const remoteKey = { host: "github.com", port: 22, ...presented };
    let count = 0;
    const fail = (code: string, message: string) => { throw { code, message }; };
    const resolve = (path: string) => {
      const requested = String(path ?? "").trim().replace(/(.)\/+$/, "$1");
      return !requested || requested === "~" ? "/home/dev" : requested.startsWith("/") ? requested : `/home/dev/${requested.replace(/^~\//, "")}`;
    };
    // Mirrors `key_root` in the iOS crate: a folder under home keys as `/~/...`.
    const keyRoot = (root: string) => root === "/home/dev" ? "/~" : root.startsWith("/home/dev/") ? "/~/" + root.slice(10) : root;
    const workspaceKey = (hostId: string, root: string) =>
      [...encoder.encode(`${hostId}\0${keyRoot(root)}`)].map(byte => byte.toString(16).padStart(2, "0")).join("").padEnd(64, "0").slice(0, 64);
    const children = (path: string) => [
      ...[...directories].filter(dir => dir.split("/").slice(0, -1).join("/") === path).map(dir => ({ path: dir, name: dir.split("/").at(-1), kind: "directory" })),
      ...[...files.keys()].filter(file => file.split("/").slice(0, -1).join("/") === path).map(file => ({ path: file, name: file.split("/").at(-1), kind: "file" })),
    ];
    function hold(transferId: string, file: string, total: number, emit: (event: string, payload: unknown) => void, done: () => unknown) {
      emit(`ios-ssh-transfer:${transferId}`, { transferred: Math.round(total * 0.4), total, file });
      return new Promise((resolve, reject) => pending.set(transferId, {
        finish: () => { emit(`ios-ssh-transfer:${transferId}`, { transferred: total, total, file }); resolve(done()); },
        cancel: () => reject({ code: "CANCELLED", message: "The transfer was cancelled." }),
      }));
    }
    const handlers: Record<string, (args: any, emit: (event: string, payload: unknown) => void, options?: any) => unknown> = {
      ios_ssh_hosts_list: () => hosts.map(host => ({ ...host, knownKeys: known.get(host.id) ?? [] })),
      ios_ssh_host_save: ({ host }) => {
        const existing = hosts.find(item => item.id === host.id);
        const saved = { ...host, id: host.id ?? `host-${++count}`, passwordSaved: existing?.passwordSaved ?? false };
        if (existing) hosts.splice(hosts.indexOf(existing), 1, saved);
        else hosts.push(saved);
        return saved;
      },
      ios_ssh_host_remove: ({ id }) => { hosts.splice(hosts.findIndex(host => host.id === id), 1); },
      ios_ssh_forget_password: ({ id }) => { hosts.find(host => host.id === id)!.passwordSaved = false; },
      "plugin:oxbit-files|ssh_keys": ({ request }) => {
        if (request.operation === "delete") keys.splice(keys.findIndex(key => key.id === request.id), 1);
        return { keys };
      },
      ios_ssh_keys_generate: ({ name }) => {
        const key = { id: `key-${++count}`, name, algorithm: "ssh-ed25519", fingerprint: "SHA256:Zq0c7Qm4l7gK3qGxw0b3m8R3pYk9uTn2vL6hJd1sFfE", publicKey: `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOxbitTestPublicKeyMaterial ${name}@oxbit-ios` };
        keys.push(key);
        return key;
      },
      ios_ssh_keys_import: ({ name, text, passphrase }) => {
        if (text?.includes("ENCRYPTED") && !passphrase) fail("PASSPHRASE_REQUIRED", "This key is encrypted. Enter its passphrase.");
        const key = { id: `key-${++count}`, name, algorithm: "ssh-rsa", fingerprint: "SHA256:Rs4Imported0Key1Fingerprint2For3Tests4Only5x", publicKey: `ssh-rsa AAAAB3Imported ${name}` };
        keys.push(key);
        return key;
      },
      ios_ssh_connect: ({ hostId, password, savePassword }) => {
        const host = hosts.find(item => item.id === hostId)!;
        if (host.auth === "password" && !password && !host.passwordSaved) return { status: "passwordRequired" };
        const hostKey = { host: host.hostname, port: host.port, ...presented };
        const saved = known.get(hostId) ?? [];
        if (!saved.length) return { status: "hostUnknown", hostKey };
        if (!saved.some(key => key.fingerprint === presented.fingerprint)) return { status: "hostChanged", hostKey, known: saved };
        connected.add(hostId);
        if (password && savePassword) host.passwordSaved = true;
        return { status: "connected", home: "/home/dev" };
      },
      ios_ssh_trust: ({ hostId, algorithm, fingerprint }) => { known.set(hostId, [{ algorithm, fingerprint, added: Date.now() }]); },
      ios_ssh_forget_host_key: ({ hostId }) => { known.delete(hostId); connected.delete(hostId); },
      ios_ssh_disconnect: ({ hostId }) => { connected.delete(hostId); },
      ios_ssh_open_root: ({ hostId, path }) => {
        if (!connected.has(hostId)) fail("NOT_CONNECTED", "Connect to this host first.");
        const root = resolve(path);
        const id = `ios:${root.replace(/\W/g, "-")}`;
        roots.set(id, root);
        return { id, root, name: root.split("/").at(-1) };
      },
      ios_ssh_close_root: ({ id }) => { roots.delete(id); },
      ios_ssh_fs_list: ({ id, path }) => {
        if (!roots.has(id)) fail("ROOT_CLOSED", "Workspace root is not open");
        if (roots.get(id) !== "/") return children(path);
        const within = (item: string) => item.split("/").slice(0, -1).join("/") === path;
        return [
          ...[...server].filter(within).map(dir => ({ path: dir, name: dir.split("/").at(-1), kind: "directory" })),
          ...[...serverFiles].filter(within).map(file => ({ path: file, name: file.split("/").at(-1), kind: "file" })),
        ];
      },
      ios_ssh_fs_read: ({ path }) => files.has(path) ? encoder.encode(files.get(path)).buffer : fail("NOT_FOUND", `ENOENT: no such file or directory: ${path}`),
      ios_ssh_fs_write: (body, _emit, options) => {
        const path = decodeURIComponent(options.headers["x-oxbit-path"]);
        files.set(path, new TextDecoder().decode(body));
        return { revision: `r${++count}`, size: body.length };
      },
      ios_ssh_fs_mkdir: ({ path }) => { directories.add(path); },
      ios_ssh_fs_rename: ({ path, to }) => { files.set(to, files.get(path)!); files.delete(path); },
      ios_ssh_fs_delete: ({ path }) => { files.delete(path); directories.delete(path); },
      "plugin:oxbit-files|pick_files": () => ({ files: [{ name: "photo.png", path: "/tmp/picked/photo.png", size: 4_200_000 }] }),
      "plugin:oxbit-files|forget_folder": () => {},
      ios_ssh_upload: ({ transferId, directory }, emit) => hold(transferId, "photo.png", 4_200_000, emit, () => {
        files.set(directory ? `${directory}/photo.png` : "photo.png", "png");
        return { files: 1, bytes: 4_200_000 };
      }),
      ios_ssh_download: ({ transferId, path }, emit) => hold(transferId, path || "workspace", 2_400_000, emit, () => ({ files: 1, bytes: 2_400_000 })),
      ios_ssh_git_prompt: ({ id }) => prompts.get(id) ?? null,
      ios_ssh_git_trust: ({ id, fingerprint }) => {
        if (prompts.get(id)?.hostKey?.fingerprint !== fingerprint) fail("NOT_FOUND", "Run the Git request again to review the server.");
        prompts.delete(id);
      },
      ios_ssh_git_forget_host_key: ({ id }) => { prompts.delete(id); },
      // Install progress, held until `release()`; then the start progress and the started runtime.
      ios_ssh_runtime_start: ({ id, hostId, path }, emit) => {
        if (!connected.has(hostId)) fail("NOT_CONNECTED", "Connect to this SSH host before opening its files.");
        emit(`ios-ssh-runtime:${id}`, { state: "progress", message: "Installing the remote runtime…" });
        return new Promise((done, reject) => pending.set(id, {
          finish: () => {
            if (seed.runtimeFailure) return reject({ code: "REMOTE_UNSUPPORTED", message: seed.runtimeFailure });
            emit(`ios-ssh-runtime:${id}`, { state: "progress", message: "Starting the remote workspace…" });
            runtimes.add(id);
            runtimeEmit = emit;
            const root = resolve(path);
            const started = { hostId, path, root, workspaceKey: workspaceKey(hostId, root) };
            starts.push(started);
            setTimeout(() => done({ url: runtimeUrl, token: "t".repeat(64), workspaceKey: started.workspaceKey, root, openFile: null }), 300);
          },
          cancel: () => reject({ code: "CANCELLED", message: "Cancelled" }),
        }));
      },
      ios_ssh_runtime_resume: ({ id }) => {
        if (!runtimes.has(id)) fail("REMOTE_RUNTIME", "This remote workspace is closed. Start it again.");
        return { url: runtimeUrl, token: "t".repeat(64), workspaceKey: "a".repeat(64), root: "/home/dev/project", openFile: null };
      },
      ios_ssh_runtime_stop: ({ id }) => { runtimes.delete(id); },
      ios_ssh_transfer_cancel: ({ transferId }) => { pending.get(transferId)?.cancel(); pending.delete(transferId); },
    };
    Object.assign(window, {
      __sshMock: {
        calls,
        files,
        starts,
        /** Sends a runtime event, as the native side does after a dropped connection. */
        runtimeEvent(payload: unknown) {
          for (const id of runtimes) runtimeEmit?.(`ios-ssh-runtime:${id}`, payload);
        },
        handles: (command: string) => command in handlers,
        /** Answers `git.clone`; other Git requests return undefined and reach the default bridge. */
        gitRequest({ id, method, params }: { id: string; method: string; params: { destination: string } }) {
          if (method !== "clone" || !seed.clone) return undefined;
          calls.push("git.clone");
          const code = clone.shift();
          if (!code) return { path: params.destination };
          prompts.set(id, code === "SSH_KEY_REQUIRED" ? { status: "keyRequired", hostname: "github.com", port: 22, username: "git" }
            : code === "HOST_KEY_UNKNOWN" ? { status: "hostUnknown", hostKey: remoteKey }
              : { status: "hostChanged", hostKey: remoteKey, known: [{ ...saved, added: 1 }] });
          throw { code, message: code === "HOST_KEY_CHANGED" ? "The host key for github.com does not match the saved key. Oxbit did not connect." : `Prompt ${code}` };
        },
        invoke(command: string, args: unknown, emit: (event: string, payload: unknown) => void, options?: unknown) {
          calls.push(command);
          return handlers[command]!(args, emit, options);
        },
        release() {
          for (const [id, transfer] of pending) { pending.delete(id); transfer.finish(); }
        },
      },
    });
  }, { seed, presented: PRESENTED, saved: SAVED, runtimeUrl: RUNTIME_URL });
}
