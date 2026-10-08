import type { Page } from "@playwright/test";

/** Installs a Tauri bridge that serves the iOS shell from memory. With `repository`, the Documents folder is a clean Git repository. */
export async function installBridge(page: Page, { repository = false } = {}) {
  await page.addInitScript(({ repository }) => {
    const storage = new Map<string, unknown>();
    const roots = new Set<string>();
    const packs = new Map<string, unknown>();
    const closed: { id: string; title: string | null | undefined }[] = [];
    const copied: string[] = [];
    let signing: { enabled: boolean; key?: Record<string, unknown> } = { enabled: false };
    let callback = 0;
    let opened = 0;
    const files = ["example.ts", "settings.jsonc"];
    const status = {
      repository: true, head: "0123456789abcdef", branch: "main", upstream: "origin/main", branches: ["main"],
      refs: [], changes: [], remotes: [{ name: "origin", url: "https://github.com/example/oxbit.git" }], ahead: 0, behind: 0,
    };
    const bridge = {
      transformCallback: () => ++callback,
      async invoke(command: string, args: any = {}) {
        if (command === "plugin:event|listen") return ++callback;
        if (command === "plugin:event|unlisten") return;
        if (command === "ios_documents_path") return "/device/Documents";
        if (command === "plugin:oxbit-files|pick_folder")
          return { id: "second", name: "Second", path: "/device/Second", stale: false };
        if (command === "plugin:oxbit-files|close_folder") return;
        if (command === "plugin:oxbit-files|git_credentials") return { authenticated: false, name: "Oxbit Test", email: "oxbit@example.test" };
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
          if (!repository) throw { code: "NOT_REPOSITORY", message: "Not a git repository" };
          return args.method === "status" ? status : [];
        }
        if (command === "ios_git_cancel") return;
        throw new Error(`Unexpected native command: ${command}`);
      },
    };
    Object.assign(window, {
      __TAURI_INTERNALS__: bridge,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener() {} },
      __iosTest: { closed, copied, get opened() { return opened; }, get signing() { return signing; } },
    });
  }, { repository });
}
