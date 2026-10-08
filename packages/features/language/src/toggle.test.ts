import { afterEach, describe, expect, it, vi } from "vitest";
import type { FeatureOptions, LanguageTransport, RpcClient } from "@oxbit/sdk";
import { createKernel } from "../../../core/src/index";
import { DocumentService } from "../../../documents/src/index";
import { BrowserFileSystem, MemoryPersistence } from "../../../host-browser/src/index";
import { LanguageService } from "./index";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
});

async function workspace(files: Record<string, string>) {
  const kernel = createKernel(), persistence = new MemoryPersistence();
  const filesystem = new BrowserFileSystem(persistence);
  for (const [path, text] of Object.entries(files)) await filesystem.write(path, text, { expectedRevision: null });
  const documents = new DocumentService(filesystem, persistence, kernel);
  for (const path of Object.keys(files)) await documents.open(path);
  let active = Object.keys(files)[0];
  const workbench = {
    activePath: () => active, notify: vi.fn(), refreshFiles: vi.fn(),
  } as unknown as FeatureOptions["workbench"];
  cleanup.push(() => kernel.dispose(), () => documents.dispose());
  return { kernel, filesystem, documents, workbench, activate: (path: string) => { active = path; } };
}

async function runtimeSetup() {
  const files = await workspace({ "a.ts": "const a = 1;\n", "b.ts": "const b = 2;\n" });
  const subscribers = new Map<string, Set<(value: any) => void>>();
  const ready = { state: "ready", name: "TypeScript", rootUri: "file:///workspace", capabilities: { completionProvider: {}, hoverProvider: true } };
  const request = vi.fn(async (method: string, params?: Record<string, any>): Promise<any> => {
    if (method === "lsp.attach") return { instanceId: "typescript:shared", ...ready };
    if (method === "lsp.start" || method === "lsp.status") return ready;
    if (method === "lsp.request") return { contents: "hover" };
    if (["lsp.notify", "lsp.detach"].includes(method)) return null;
    throw new Error(`Unexpected method ${method} ${JSON.stringify(params)}`);
  });
  const runtime = {
    connected: true, request,
    subscribe(event: string, listener: (value: any) => void) {
      const listeners = subscribers.get(event) ?? new Set();
      listeners.add(listener); subscribers.set(event, listeners);
      return () => { listeners.delete(listener); };
    },
  } as unknown as RpcClient;
  const language = new LanguageService({ ...files, runtime } as unknown as FeatureOptions);
  cleanup.push(() => language.dispose());
  const publish = (path: string, message: string) => {
    for (const listener of subscribers.get("lsp.notification") ?? [])
      listener({ instanceId: "typescript:shared", method: "textDocument/publishDiagnostics", params: { uri: `file:///workspace/${path}`, diagnostics: [{ message, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }] } });
  };
  const notified = (method: string, path: string) => request.mock.calls.filter(([name, params]) => name === "lsp.notify" && params?.method === method && params.params.textDocument.uri === `file:///workspace/${path}`).length;
  return { ...files, language, request, publish, notified };
}

describe("per-file language server toggle", () => {
  it("detaches one runtime-backed file while another file on the same server keeps working", async () => {
    const { language, request, publish, notified, kernel, documents } = await runtimeSetup();
    const settings = JSON.stringify([kernel.configuration.get("languageServers"), kernel.configuration.get("files.associations")]);
    await Promise.all(["a.ts", "b.ts"].flatMap(path => language.servicesForPath(path)).map(service => service.start()));
    publish("a.ts", "error in a"); publish("b.ts", "error in b");
    await vi.waitFor(() => expect([...language.diagnostics.keys()].sort()).toEqual(["a.ts", "b.ts"]));
    expect(kernel.context.get("lsp.fileDisabled")).toBe(false);

    language.setFileEnabled("a.ts", false);
    expect(language.fileEnabled("a.ts")).toBe(false);
    expect(request).toHaveBeenCalledWith("lsp.detach", { instanceId: "typescript:shared", path: "a.ts" });
    expect(request.mock.calls.some(([method, params]) => method === "lsp.detach" && params?.path === "b.ts")).toBe(false);
    expect(language.servicesForPath("a.ts")).toEqual([]);
    expect(language.canUseLsp("a.ts")).toBe(false);
    expect(language.extensions("a.ts")).toEqual([]);
    expect(language.diagnostics.has("a.ts")).toBe(false);
    expect(kernel.context.get("lsp.fileDisabled")).toBe(true);
    await expect(language.at("textDocument/hover", "a.ts", 0)).rejects.toThrow("off for this file");
    publish("a.ts", "late error in a");
    documents.get("a.ts")!.replace("const a = 3;\n");
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(language.diagnostics.has("a.ts")).toBe(false);
    expect(notified("textDocument/didChange", "a.ts")).toBe(0);
    expect(language.diagnostics.get("b.ts")?.[0].message).toBe("error in b");
    expect(language.eligible("b.ts", "textDocument/hover")).toHaveLength(1);
    await expect(language.at("textDocument/hover", "b.ts", 0)).resolves.toEqual({ contents: "hover" });

    language.setFileEnabled("a.ts", true);
    await vi.waitFor(() => expect(notified("textDocument/didOpen", "a.ts")).toBe(2));
    expect(language.servicesForPath("a.ts")[0]?.state).toBe("ready");
    expect(kernel.context.get("lsp.fileDisabled")).toBe(false);
    expect(notified("textDocument/didOpen", "b.ts")).toBe(1);
    expect(JSON.stringify([kernel.configuration.get("languageServers"), kernel.configuration.get("files.associations")])).toBe(settings);
  });

  it("closes and reopens a file on a contributed server without touching other files", async () => {
    const { kernel, documents, workbench, filesystem } = await workspace({ "main.foo": "main", "other.foo": "other" });
    kernel.contributions.register({ id: "foo.language", kind: "language", title: "Foo", data: { id: "foo", extensions: [".foo"] } });
    const listeners = new Set<(method: string, params: any) => void>();
    const transport: LanguageTransport = {
      request: vi.fn(async (method: string) => method === "initialize" ? { capabilities: { textDocumentSync: 1, hoverProvider: true } } : { contents: "hover" }),
      notify: vi.fn(), dispose: vi.fn(),
      onNotification: listener => { listeners.add(listener); return { dispose: () => { listeners.delete(listener); } }; },
    };
    kernel.contributions.register({ id: "foo.server", kind: "transport", title: "Foo server", data: { languages: ["foo"], createTransport: () => transport } });
    const language = new LanguageService({ kernel, documents, workbench, filesystem } as unknown as FeatureOptions);
    cleanup.push(() => language.dispose());
    const publish = (path: string) => { for (const listener of listeners) listener("textDocument/publishDiagnostics", { uri: `file:///workspace/${path}`, diagnostics: [{ message: path, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }] }); };
    const notified = (method: string, path: string) => vi.mocked(transport.notify).mock.calls.filter(([name, params]: any[]) => name === method && params.textDocument.uri === `file:///workspace/${path}`).length;
    await language.control("foo.server", "start");
    publish("main.foo"); publish("other.foo");
    await vi.waitFor(() => expect([...language.diagnostics.keys()].sort()).toEqual(["main.foo", "other.foo"]));

    language.setFileEnabled("main.foo", false);
    expect(notified("textDocument/didClose", "main.foo")).toBe(1);
    expect(notified("textDocument/didClose", "other.foo")).toBe(0);
    expect(language.diagnostics.has("main.foo")).toBe(false);
    expect(language.servers).toEqual([]);
    publish("main.foo");
    documents.get("main.foo")!.replace("changed");
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(language.diagnostics.has("main.foo")).toBe(false);
    expect(notified("textDocument/didChange", "main.foo")).toBe(0);
    expect(language.diagnostics.has("other.foo")).toBe(true);
    await expect(language.at("textDocument/hover", "other.foo", 0)).resolves.toEqual({ contents: "hover" });

    language.setFileEnabled("main.foo", true);
    await vi.waitFor(() => expect(notified("textDocument/didOpen", "main.foo")).toBe(2));
    expect(vi.mocked(transport.notify).mock.calls.at(-1)?.[1]).toMatchObject({ textDocument: { text: "changed" } });
    expect(language.servers.map(server => server.state)).toEqual(["ready"]);
  });

  it("forgets the off state when the file closes", async () => {
    const { language, documents } = await runtimeSetup();
    language.setFileEnabled("b.ts", false);
    documents.close("b.ts");
    expect(language.fileEnabled("b.ts")).toBe(true);
  });
});
