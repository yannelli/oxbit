import type { Page } from "@playwright/test";

export interface BridgeRuntime { runtimeId: string; name: string; version?: string; host: string; port: number; url: string }
export interface BridgeAccount { id: string; provider: "github" | "gitea"; host: string; url?: string; login: string; isDefault: boolean }
/** One scripted model API answer: `chunks` stream `delay` ms apart (default 5), then `status` (default 200) ends it with `body`. */
export interface BridgeAgentResponse { status?: number; chunks?: string[]; body?: string; delay?: number }

/** Model endpoints the specs reach, allowed in the AI data sharing prompt with the seeded `agentKeys`; a spec's `aiConsent` replaces both. */
const AI_CONSENT = ["openai https://api.openai.com", "anthropic https://api.anthropic.com", "chatgpt https://chatgpt.com", "openai-compatible https://openrouter.ai", "openai-compatible https://models.test"];

/** Serves the iOS shell from memory. `repository` makes Documents a clean Git repository; `accounts` seeds Git accounts. */
/** An added token names its login; the token `rejected` fails validation. */
/** `runtimes` are Bonjour results; `localNetworkDenied` reports iOS blocking them; `stored` seeds app storage as `scope:key`. No runtime answers its URL. */
/** `notificationTapped` launches the app from a notification tap; `__iosTest.tapNotification()` taps one later. */
/** `notificationPermission` seeds the iOS permission; `__iosTest.liveActivityToken(hex)` reports a Live Activity push token. */
/** `agentResponses` answers model requests by path; a list answers successive requests and repeats its last entry. `agentKeys` seeds saved keys as `api origin`.
 * `agentChatGPT` records `agent_models_chatgpt` calls; the first poll is `pending`, the next completes the sign-in. */
export async function installBridge(page: Page, { repository = false, accounts = [] as BridgeAccount[], runtimes = [] as BridgeRuntime[], localNetworkDenied = false, stored = {} as Record<string, unknown>, notificationTapped = false, notificationPermission = "default", agentResponses = {} as Record<string, BridgeAgentResponse | BridgeAgentResponse[]>, agentKeys = [] as string[], aiConsent = undefined as string[] | undefined } = {}) {
  await page.addInitScript(({ repository, accounts: seeded, runtimes, localNetworkDenied, stored, notificationTapped, notificationPermission, agentResponses, agentKeys: seededKeys, aiConsent, defaultConsent }) => {
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
    const storage = new Map<string, unknown>([["profile:ai-consent", aiConsent ?? [...defaultConsent, ...seededKeys]], ...Object.entries(stored)]);
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
    const externals: string[] = [];
    let signing: { enabled: boolean; key?: Record<string, unknown> } = { enabled: false };
    let callback = 0;
    const notifications: { title: string; body?: string; tag?: string }[] = [];
    let tapChannel: { id: number } | undefined;
    let tapIndex = 0;
    let tapped = notificationTapped;
    const tapNotification = () => {
      if (tapChannel) callbacks.get(tapChannel.id)?.({ index: tapIndex++, message: {} });
      else tapped = true;
    };
    let activityTokenChannel: { id: number } | undefined;
    let activityTokenIndex = 0;
    let activityToken: string | undefined;
    const activityUpdates: unknown[] = [];
    const liveActivityToken = (token: string) => {
      activityToken = token;
      if (activityTokenChannel) callbacks.get(activityTokenChannel.id)?.({ index: activityTokenIndex++, message: { token } });
    };
    const agentKeys = new Map(seededKeys.map(account => [account, "sk-seeded"]));
    const agentRequests: { id: string; api: string; baseUrl?: string; method: string; path: string; body?: unknown }[] = [];
    const agentCancels: string[] = [];
    const agentChatGPT: { operation: string; deviceAuthId?: string; userCode?: string }[] = [];
    const agentTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const agentUses = new Map<string, number>();
    const agentAccount = (api: string, baseUrl?: string) => {
      if (api === "openai") return "openai https://api.openai.com";
      if (api === "anthropic") return "anthropic https://api.anthropic.com";
      if (api === "chatgpt") return "chatgpt https://chatgpt.com";
      const url = new URL(baseUrl ?? "");
      if (api !== "openai-compatible" || url.protocol !== "https:")
        throw { code: "AGENT_MODELS", message: "Enter an https:// base URL without credentials, a query, or a fragment." };
      return `${api} ${url.origin}`;
    };
    const base64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));
    function agentStream(args: { id: string; api: string; baseUrl?: string; method: string; path: string; body?: string; channel: { id: number } }) {
      if (!agentKeys.has(agentAccount(args.api, args.baseUrl))) throw { code: "MISSING_KEY", message: "Add an API key in Agent setup" };
      const { id, api, baseUrl, method, path } = args;
      agentRequests.push({ id, api, baseUrl, method, path, body: args.body === undefined ? undefined : JSON.parse(args.body) });
      const script = agentResponses[path];
      const list = Array.isArray(script) ? script : script ? [script] : [];
      const uses = agentUses.get(path) ?? 0;
      agentUses.set(path, uses + 1);
      const response = list[Math.min(uses, list.length - 1)] ?? { status: 404, body: JSON.stringify({ error: { message: `No scripted response for ${path}` } }) };
      const status = response.status ?? 200;
      const ok = status >= 200 && status < 300;
      const steps: unknown[] = [
        ...ok ? (response.chunks ?? []).map(text => ({ type: "chunk", data: base64(text) })) : [],
        ok ? { type: "end", status } : { type: "end", status, body: response.body ?? "" },
      ];
      let index = 0;
      const next = () => {
        const message = steps.shift();
        if (!message) return;
        callbacks.get(args.channel.id)?.({ index: index++, message });
        if (steps.length) agentTimers.set(id, setTimeout(next, response.delay ?? 5));
        else agentTimers.delete(id);
      };
      agentTimers.set(id, setTimeout(next, response.delay ?? 5));
    }
    const callbacks = new Map<number, (event: unknown) => void>();
    const listeners: { id: number; event: string; handler: number }[] = [];
    const emit = (event: string, payload: unknown) => {
      for (const listener of listeners.filter(item => item.event === event))
        callbacks.get(listener.handler)?.({ event, id: listener.id, payload });
    };
    let opened = 0;
    const files = ["example.ts", "settings.jsonc"];
    const contents = (id: string, path: string) =>
      path === "settings.jsonc" ? '// Keep comments\n{"enabled":true}' : 'const workspace = "' + id + '";\n';
    const searches: { method: string; params: Record<string, unknown> }[] = [];
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
        if (command === "ios_open_external") { externals.push(args.url); return; }
        if (command === "plugin:oxbit-files|notification_permission") return { permission: notificationPermission };
        if (command === "plugin:oxbit-files|request_notification_permission") return { permission: notificationPermission = "granted" };
        if (command === "plugin:oxbit-files|register_remote_notifications") return { token: "a1b2c3d4", environment: "development" };
        if (command === "plugin:oxbit-files|live_activity") { activityUpdates.push(args.update); return { enabled: true }; }
        if (command === "plugin:oxbit-files|watch_live_activity_tokens") {
          activityTokenChannel = args.channel;
          activityTokenIndex = 0;
          if (activityToken) liveActivityToken(activityToken);
          return;
        }
        if (command === "plugin:oxbit-files|unwatch_live_activity_tokens") {
          if (activityTokenChannel?.id === args.id) activityTokenChannel = undefined;
          return;
        }
        if (command === "plugin:oxbit-files|notify") { notifications.push({ title: args.title, body: args.body, tag: args.tag }); return; }
        if (command === "plugin:oxbit-files|watch_notification_taps") {
          tapChannel = args.channel;
          tapIndex = 0;
          if (tapped) { tapped = false; tapNotification(); }
          return;
        }
        if (command === "plugin:oxbit-files|unwatch_notification_taps") {
          if (tapChannel?.id === args.id) tapChannel = undefined;
          return;
        }
        if (command === "plugin:oxbit-files|agent_models_stream") return agentStream(args);
        if (command === "plugin:oxbit-files|agent_models_cancel") {
          agentCancels.push(args.id);
          clearTimeout(agentTimers.get(args.id));
          agentTimers.delete(args.id);
          return;
        }
        if (command === "plugin:oxbit-files|agent_models_key") {
          const account = agentAccount(args.api, args.baseUrl);
          if (args.operation === "has") return { saved: agentKeys.has(account) };
          if (args.operation === "save" && args.api === "chatgpt") throw { code: "AGENT_KEY", message: "Sign in with ChatGPT in Agent setup" };
          if (args.operation === "save") agentKeys.set(account, args.key);
          if (args.operation === "remove") agentKeys.delete(account);
          return;
        }
        if (command === "plugin:oxbit-files|agent_models_chatgpt") {
          agentChatGPT.push({ operation: args.operation, deviceAuthId: args.deviceAuthId, userCode: args.userCode });
          if (args.operation === "start")
            return { deviceAuthId: "device-1", userCode: "ABCD-1234", verificationUrl: "https://auth.openai.com/codex/device", interval: 1, expiresAt: Date.now() + 900000 };
          if (agentChatGPT.filter(call => call.operation === "poll").length === 1) return { status: "pending" };
          agentKeys.set(agentAccount("chatgpt"), "chatgpt-signed-in");
          return { status: "complete" };
        }
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
          return new TextEncoder().encode(contents(args.id, args.path)).buffer;
        }
        if (command === "ios_search_request") {
          if (!roots.has(args.id)) throw { code: "ROOT_CLOSED", message: "Workspace root is not open" };
          searches.push({ method: args.method, params: args.params });
          const query = String(args.params.query).toLowerCase();
          if (args.method === "files")
            return files.filter(path => {
              let at = 0;
              return [...query].every(char => (at = path.toLowerCase().indexOf(char, at) + 1) > 0);
            });
          const matches = [];
          for (const path of files) {
            const text = contents(args.id, path);
            const bytes = new TextEncoder().encode(text);
            const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
            const revision = [...digest].map(byte => byte.toString(16).padStart(2, "0")).join("");
            let offset = 0;
            for (const [index, line] of text.split("\n").entries()) {
              const column = line.toLowerCase().indexOf(query);
              if (query && column >= 0)
                matches.push({ path, line: index + 1, column: column + 1, from: offset + column, to: offset + column + query.length, text: line, revision });
              offset += line.length + 1;
            }
          }
          return { matches, truncated: false };
        }
        if (command === "ios_search_cancel") return;
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
      __iosTest: {
        closed, copied, externals, storage, searches, runtimeRequests, notifications, tapNotification, liveActivityToken, activityUpdates,
        agentKeys, agentRequests, agentCancels, agentChatGPT, get opened() { return opened; }, get signing() { return signing; },
      },
    });
  }, { repository, accounts, runtimes, localNetworkDenied, stored, notificationTapped, notificationPermission, agentResponses, agentKeys, aiConsent, defaultConsent: AI_CONSENT });
}
