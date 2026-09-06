import { afterEach, describe, expect, it, vi } from "vitest";
import type { FeatureOptions, RpcClient } from "@zapp/sdk";
import { createKernel } from "../../../core/src/index";
import { DocumentService } from "../../../documents/src/index";
import {
  BrowserFileSystem,
  MemoryPersistence,
} from "../../../host-browser/src/index";
import { LanguageService, offset, position } from "./index";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
});
async function setup(shared = true) {
  const kernel = createKernel();
  const persistence = new MemoryPersistence();
  const filesystem = new BrowserFileSystem(persistence) as BrowserFileSystem & {
    shared: Set<string>;
  };
  filesystem.shared = new Set(shared ? ["index.ts"] : []);
  await filesystem.write("index.ts", "const answer = 1;\n", {
    expectedRevision: null,
  });
  const documents = new DocumentService(filesystem, persistence, kernel);
  const document = await documents.open("index.ts");
  const versions: Record<string, number> = {
    "file:///workspace/index.ts": shared ? 41 : document.version,
  };
  const subscribers = new Map<string, Set<(value: any) => void>>();
  const provider = vi.fn(
    async (
      _method: string,
      _params: any,
      _signal?: AbortSignal,
    ): Promise<any> => null,
  );
  const request = vi.fn(
    async (
      method: string,
      params?: Record<string, any>,
      options?: { signal?: AbortSignal },
    ) => {
      if (method === "lsp.start" || method === "lsp.restart")
        return {
          rootUri: "file:///workspace",
          capabilities: {
            renameProvider: true,
            definitionProvider: true,
            completionProvider: {},
            codeActionProvider: { resolveProvider: true },
            documentFormattingProvider: true,
          },
        };
      if (method === "lsp.versions") return { ...versions };
      if (method === "lsp.notify") {
        if (params?.params?.textDocument?.version !== undefined)
          versions[params.params.textDocument.uri] =
            params.params.textDocument.version;
        return null;
      }
      if (method === "lsp.request")
        return provider(params!.method, params!.params, options?.signal);
      throw new Error(`Unexpected method ${method}`);
    },
  );
  const runtime = {
    connected: true,
    request,
    subscribe(event: string, listener: (value: any) => void) {
      const listeners = subscribers.get(event) ?? new Set();
      listeners.add(listener);
      subscribers.set(event, listeners);
      return () => {
        listeners.delete(listener);
      };
    },
  } as RpcClient;
  const workbench = {
    activePath: () => "index.ts",
    notify: vi.fn(),
    refreshFiles: vi.fn(),
    openFile: vi.fn(),
    closeView: vi.fn(),
    prompt: vi.fn(),
  } as unknown as FeatureOptions["workbench"];
  const language = new LanguageService({
    kernel,
    filesystem,
    documents,
    runtime,
    workbench,
  });
  cleanup.push(
    () => kernel.dispose(),
    () => documents.dispose(),
    () => language.dispose(),
  );
  return {
    kernel,
    filesystem,
    documents,
    document,
    language,
    versions,
    request,
    provider,
    subscribers,
  };
}

describe("language document positions", () => {
  it("uses UTF-16 code units and validates server ranges", () => {
    const text = "A😀B\né\n";
    expect(offset(text, { line: 0, character: 3 })).toBe(3);
    expect(offset(text, { line: 1, character: 1 })).toBe(6);
    expect(position(text, 5)).toEqual({ line: 1, character: 0 });
    expect(offset("first\r\nsecond", { line: 1, character: 2 })).toBe(9);
    expect(() => offset(text, { line: 9, character: 0 })).toThrow(
      "invalid line",
    );
    expect(() => offset(text, { line: 0, character: 1.5 })).toThrow(
      "invalid column",
    );
    expect(() => position(text, -1)).toThrow("Invalid document offset");
  });
});

describe("language edit contracts", () => {
  it("accepts canonical room versions that differ from local document versions", async () => {
    const { document, language } = await setup();
    document.replace("const answer = 2;\n");
    const snapshots = await language.snapshots();
    expect(snapshots.get("index.ts")).toMatchObject({
      version: 1,
      lspVersion: 41,
    });
    await language.applyWorkspaceEdit(
      {
        documentChanges: [
          {
            textDocument: { uri: language.uri("index.ts"), version: 41 },
            edits: [
              {
                range: {
                  start: { line: 0, character: 6 },
                  end: { line: 0, character: 12 },
                },
                newText: "renamed",
              },
            ],
          },
        ],
      },
      snapshots,
    );
    expect(document.text.toString()).toBe("const renamed = 2;\n");
    expect(document.dirty).toBe(true);
  });
  it("rejects a canonical room change before applying a workspace edit", async () => {
    const { document, language, versions } = await setup();
    const snapshots = await language.snapshots();
    versions[language.uri("index.ts")] = 42;
    await expect(
      language.applyWorkspaceEdit(
        {
          changes: {
            [language.uri("index.ts")]: [
              {
                range: {
                  start: { line: 0, character: 0 },
                  end: { line: 0, character: 5 },
                },
                newText: "let",
              },
            ],
          },
        },
        snapshots,
      ),
    ).rejects.toThrow("stale canonical");
    expect(document.text.toString()).toBe("const answer = 1;\n");
  });
  it("resolves a code action and applies its edit through shared documents", async () => {
    const { document, language, provider } = await setup();
    const snapshots = await language.snapshots();
    provider.mockImplementation(async (method) =>
      method === "codeAction/resolve"
        ? {
            title: "Convert const to let",
            edit: {
              changes: {
                [language.uri("index.ts")]: [
                  {
                    range: {
                      start: { line: 0, character: 0 },
                      end: { line: 0, character: 5 },
                    },
                    newText: "let",
                  },
                ],
              },
            },
          }
        : null,
    );
    await language.applyCodeAction(
      { title: "Convert const to let", data: { action: 1 } },
      snapshots,
    );
    expect(provider).toHaveBeenCalledWith(
      "codeAction/resolve",
      expect.anything(),
      expect.any(AbortSignal),
    );
    expect(document.text.toString()).toBe("let answer = 1;\n");
  });
  it("checks resource revisions and applies create plus document edits", async () => {
    const { filesystem, documents, language } = await setup();
    const snapshots = await language.snapshots();
    await language.applyWorkspaceEdit(
      {
        documentChanges: [
          { kind: "create", uri: language.uri("new.ts") },
          {
            textDocument: { uri: language.uri("new.ts"), version: null },
            edits: [
              {
                range: {
                  start: { line: 0, character: 0 },
                  end: { line: 0, character: 0 },
                },
                newText: "export const created = true;",
              },
            ],
          },
        ],
      },
      snapshots,
    );
    expect(documents.get("new.ts")?.text.toString()).toBe(
      "export const created = true;",
    );
    const disk = await filesystem.read("index.ts");
    await filesystem.write("index.ts", "external", {
      expectedRevision: disk.revision,
    });
    await expect(
      language.applyWorkspaceEdit(
        {
          documentChanges: [
            {
              kind: "rename",
              oldUri: language.uri("index.ts"),
              newUri: language.uri("renamed.ts"),
            },
          ],
        },
        snapshots,
      ),
    ).rejects.toThrow("changed");
    await expect(filesystem.read("renamed.ts")).rejects.toThrow("not found");
  });
  it("opens existing unshared documents on start and after restart", async () => {
    const { language, request } = await setup(false);
    await language.start();
    await language.restart();
    const opens = request.mock.calls.filter(
      ([method, params]) =>
        method === "lsp.notify" && params?.method === "textDocument/didOpen",
    );
    expect(opens).toHaveLength(2);
    expect(opens[0]?.[1]?.params.textDocument.text).toBe("const answer = 1;\n");
  });
  it("cancels an obsolete response and clears availability after server failure", async () => {
    const { language, document, provider, subscribers, kernel } = await setup();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    provider.mockImplementation(
      (_method, _params, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Cancelled", "AbortError")),
            { once: true },
          );
          started();
        }),
    );
    const pending = language.at("textDocument/completion", "index.ts", 6);
    const rejected = expect(pending).rejects.toThrow("Cancelled");
    await ready;
    document.replace("changed");
    await rejected;
    for (const listener of subscribers.get("lsp.notification") ?? [])
      listener({
        method: "zapp/serverState",
        params: { state: "stopped", error: "Process exited" },
      });
    expect(language.state).toBe("stopped");
    expect(kernel.context.get("lsp")).toBe(false);
    expect(language.supports("textDocument/completion")).toBe(false);
  });
});
