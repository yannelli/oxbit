import type { Page } from "@playwright/test";

export interface BridgeRuntime { runtimeId: string; name: string; version?: string; host: string; port: number; url: string }
export interface BridgeAccount { id: string; provider: "github" | "gitea"; host: string; url?: string; login: string; isDefault: boolean }

/** Serves the iOS shell from memory. `repository` makes Documents a clean Git repository; `accounts` seeds Git accounts. */
/** An added token names its login; the token `rejected` fails validation. */
/** `runtimes` are Bonjour results; `localNetworkDenied` reports iOS blocking them; `stored` seeds app storage as `scope:key`. No runtime answers its URL. */
export async function installBridge(page: Page, { repository = false, accounts = [] as BridgeAccount[], runtimes = [] as BridgeRuntime[], localNetworkDenied = false, stored = {} as Record<string, unknown> } = {}) {
  await page.addInitScript(({ repository, accounts: seeded, runtimes, localNetworkDenied, stored }) => {
    const author = { name: "Oxbit Test", email: "oxbit@example.test" };
    let accounts = seeded.map(account => ({ ...account }));
    let created = 0;
    const credentials = () => ({ ...author, accounts: accounts.map(account => ({ ...account })) });
    const missing = { code: "GIT_CREDENTIALS", message: "This Git account no longer exists." };
    function add(provider: "github" | "gitea", host: string, login: string, url?: string) {
      const known = accounts.find(account => account.provider === provider && account.host === host && account.login.toLowerCase() === login.toLowerCase());
      if (known) return;
      accounts.push({ id: `account-${++created}`, provider, host, url, login, isDefault: !accounts.some(account => account.host === host && account.isDefault) });
    }
    function gitCredentials(request: { operation: string; id?: string; token?: string; url?: string; name?: string; email?: string }) {
      if (request.token === "rejected") throw { code: "GIT_CREDENTIALS", message: "GitHub rejected this token or its permissions." };
      if (request.operation === "save") Object.assign(author, { name: request.name, email: request.email });
      if (request.operation === "addGitHub") add("github", "github.com", request.token!);
      if (request.operation === "addGitea") {
        const url = new URL(request.url!);
        add("gitea", url.host, request.token!, url.origin + url.pathname.replace(/\/+$/, ""));
      }
      if (request.operation === "remove") {
        const removed = accounts.find(account => account.id === request.id);
        if (!removed) throw missing;
        accounts = accounts.filter(account => account !== removed);
        const next = accounts.find(account => account.host === removed.host);
        if (removed.isDefault && next) next.isDefault = true;
      }
      if (request.operation === "setDefault") {
        const chosen = accounts.find(account => account.id === request.id);
        if (!chosen) throw missing;
        for (const account of accounts) if (account.host === chosen.host) account.isDefault = account === chosen;
      }
      return credentials();
    }
    const storage = new Map<string, unknown>(Object.entries(stored));
    const runtimeRequests: Record<string, unknown>[] = [];
    function runtimeCredentials(request: { operation: string; url: string; runtimeId?: string; code?: string }) {
      runtimeRequests.push({ ...request });
      if (request.operation === "health") throw { code: "RUNTIME_HEALTH", message: "The runtime is unreachable: Could not connect to the server." };
      if (request.operation === "pair") {
        const runtime = runtimes.find(item => item.url === request.url);
        return { token: "paired-token", runtime: runtime && { id: runtime.runtimeId, name: runtime.name, version: runtime.version ?? "0.4.1", startedAt: 1 } };
      }
      return request.operation === "get" ? { token: "saved-token" } : {};
    }
    const roots = new Set<string>();
    const packs = new Map<string, unknown>();
    const closed: { id: string; title: string | null | undefined }[] = [];
    const copied: string[] = [];
    let signing: { enabled: boolean; key?: Record<string, unknown> } = { enabled: false };
    let callback = 0;
    const callbacks = new Map<number, (event: unknown) => void>();
    const listeners: { id: number; event: string; handler: number }[] = [];
    const emit = (event: string, payload: unknown) => {
      for (const listener of listeners.filter(item => item.event === event))
        callbacks.get(listener.handler)?.({ event, id: listener.id, payload });
    };
    let opened = 0;
    const files = ["example.ts", "settings.jsonc"];
    const status = {
      repository: true, head: "0123456789abcdef", branch: "main", upstream: "origin/main", branches: ["main"],
      refs: [], changes: [], remotes: [{ name: "origin", url: "https://github.com/example/oxbit.git" }], ahead: 0, behind: 0,
    };
    const bridge = {
      transformCallback: (handler: (event: unknown) => void) => {
        callbacks.set(++callback, handler);
        return callback;
      },
      async invoke(command: string, args: any = {}, options?: unknown) {
        if (command === "plugin:event|listen") {
          listeners.push({ id: ++callback, event: args.event, handler: args.handler });
          return callback;
        }
        if (command === "plugin:event|unlisten") {
          const index = listeners.findIndex(item => item.id === args.eventId);
          if (index >= 0) listeners.splice(index, 1);
          return;
        }
        if (command === "ios_documents_path") return "/device/Documents";
        if (command === "plugin:oxbit-files|pick_folder")
          return { id: "second", name: "Second", path: "/device/Second", stale: false };
        if (command === "plugin:oxbit-files|close_folder") return;
        if (command === "plugin:oxbit-files|git_credentials") return gitCredentials(args.request);
        if (command === "plugin:oxbit-files|runtime_credentials") return runtimeCredentials(args.request);
        if (command === "plugin:oxbit-files|runtime_discovery") return { runtimes: args.request.operation === "stop" ? [] : runtimes, localNetworkDenied };
        if (command === "plugin:oxbit-files|commit_signing") {
          const request = args.request;
          if (request.operation === "generate") signing = {
            enabled: signing.enabled,
            key: {
              fingerprint: "0123456789ABCDEF0123456789ABCDEF01234567", keyId: "89ABCDEF01234567",
              userIds: [`${request.name} <${request.email}>`], createdAt: 1791417600,
              publicKey: "-----BEGIN PGP PUBLIC KEY BLOCK-----\n\nfixture\n-----END PGP PUBLIC KEY BLOCK-----\n",
            },
          };
          if (request.operation === "setEnabled") signing = { ...signing, enabled: request.enabled };
          if (request.operation === "remove") signing = { enabled: false };
          return signing;
        }
        if (command === "plugin:clipboard-manager|write_text") { copied.push(args.text); return; }
        if (command === "ios_storage_get") return storage.get(`${args.scope}:${args.key}`) ?? null;
        if (command === "ios_storage_set") { storage.set(`${args.scope}:${args.key}`, args.value); return; }
        if (command === "ios_icon_packs_read") return [...packs.values()];
        if (command === "ios_icon_packs_mutate") {
          const current = packs.get(args.id) as { enabled?: boolean } | undefined;
          if (args.operation === "put") packs.set(args.id, { ...args.pack, enabled: current?.enabled ?? true });
          if (args.operation === "remove") packs.delete(args.id);
          if (args.operation === "enable" && current) packs.set(args.id, { ...current, enabled: args.enabled });
          return;
        }
        if (command === "ios_fs_open_root") {
          opened++;
          roots.add(args.path);
          return { id: args.path, root: args.path, name: args.path.split("/").at(-1) };
        }
        if (command === "ios_fs_close_root") {
          closed.push({ id: args.id, title: document.querySelector(".workspace-title")?.textContent });
          roots.delete(args.id);
          return;
        }
        if (command === "ios_fs_watch" || command === "ios_fs_unwatch") return;
        if (command === "ios_fs_list") {
          if (!roots.has(args.id)) throw { code: "ROOT_CLOSED", message: "Workspace root is not open" };
          return args.path ? [] : files.map(path => ({ path, name: path, kind: "file" }));
        }
        if (command === "ios_fs_read") {
          if (!roots.has(args.id)) throw { code: "ROOT_CLOSED", message: "Workspace root is not open" };
          if (!files.includes(args.path)) throw { code: "NOT_FOUND", message: "File not found" };
          const text = args.path === "settings.jsonc" ? '// Keep comments\n{"enabled":true}' : 'const workspace = "' + args.id + '";\n';
          return new TextEncoder().encode(text).buffer;
        }
        if (command === "ios_lsp_message") {
          if (args.method !== "exit" && !roots.has(args.workspaceId)) throw { code: "ROOT_CLOSED", message: "Workspace root is not open" };
          return { payload: JSON.stringify({ result: args.method === "initialize" ? { capabilities: { textDocumentSync: 1 } } : null, notifications: [] }) };
        }
        if (command === "ios_git_request") {
          const handled = (window as any).__sshMock?.gitRequest(args);
          if (handled !== undefined) return handled;
          if (!repository) throw { code: "NOT_REPOSITORY", message: "Not a git repository" };
          return args.method === "status" ? status : [];
        }
        if (command === "ios_git_cancel") return;
        const ssh = (window as any).__sshMock;
        if (ssh?.handles(command)) return ssh.invoke(command, args, emit, options);
        throw new Error(`Unexpected native command: ${command}`);
      },
    };
    Object.assign(window, {
      __TAURI_INTERNALS__: bridge,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener() {} },
      __iosTest: { closed, copied, storage, runtimeRequests, get opened() { return opened; }, get signing() { return signing; } },
    });
  }, { repository, accounts, runtimes, localNetworkDenied, stored });
}
