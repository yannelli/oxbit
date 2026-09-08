import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  FeatureOptions,
  LanguageTransport,
  ProviderCodeAction,
} from "@oxbit/sdk";
import { createKernel } from "../../../core/src/index";
import { DocumentService } from "../../../documents/src/index";
import {
  BrowserFileSystem,
  MemoryPersistence,
} from "../../../host-browser/src/index";
import { LanguageService } from "./index";
import { LanguageProviders } from "./providers";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
});

async function setup() {
  const kernel = createKernel(),
    persistence = new MemoryPersistence();
  const filesystem = new BrowserFileSystem(persistence);
  await filesystem.write("main.foo", "hello world", { expectedRevision: null });
  const documents = new DocumentService(filesystem, persistence, kernel);
  const document = await documents.open("main.foo");
  kernel.contributions.register({
    id: "foo.language",
    kind: "language",
    title: "Foo",
    data: { id: "foo", extensions: [".foo"] },
  });
  const workbench = {
    activePath: () => "main.foo",
    notify: vi.fn(),
    refreshFiles: vi.fn(),
  } as unknown as FeatureOptions["workbench"];
  const options = { kernel, filesystem, documents, workbench };
  cleanup.push(
    () => kernel.dispose(),
    () => documents.dispose(),
  );
  return { ...options, options, document };
}

function transport() {
  const listeners = new Set<(method: string, params: any) => void>();
  const request = vi.fn(
    async (
      method: string,
      _params: unknown,
      signal?: AbortSignal,
    ): Promise<any> => {
      if (method === "initialize")
        return {
          capabilities: { textDocumentSync: 1, completionProvider: {}, hoverProvider: true },
        };
      if (method === "textDocument/completion")
        return [{ label: "from foo transport" }];
      if (method === "shutdown") return null;
      return new Promise((_resolve, reject) =>
        signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Cancelled", "AbortError")),
          { once: true },
        ),
      );
    },
  );
  const result: LanguageTransport = {
    request,
    notify: vi.fn(),
    onNotification: (listener) => {
      listeners.add(listener);
      return {
        dispose: () => {
          listeners.delete(listener);
        },
      };
    },
    dispose: vi.fn(),
  };
  return {
    result,
    request,
    emit: (method: string, params: any) => {
      for (const listener of listeners) listener(method, params);
    },
  };
}

describe("contributed language providers", () => {
  it("invalidates contributed completion items after edits or provider replacement", async () => {
    const { options, kernel, document } = await setup();
    const provider = { languages: ["foo"], provideCompletions: () => [{ label: "hello" }] };
    const registration = kernel.contributions.register({ id: "foo.completion", kind: "completion", title: "Foo completion", data: provider });
    const providers = new LanguageProviders(options, () => {}); cleanup.push(() => providers.dispose());
    const [item] = await providers.completions("main.foo", 0); expect(providers.ownsCompletion(item)).toBe(true);
    document.replace("edited"); expect(providers.ownsCompletion(item)).toBe(false);
    const [fresh] = await providers.completions("main.foo", 0); expect(providers.ownsCompletion(fresh)).toBe(true);
    registration.dispose(); kernel.contributions.register({ id: "foo.completion", kind: "completion", title: "Replacement", data: { ...provider } });
    expect(providers.ownsCompletion(fresh)).toBe(false);
  });
  it("lists dormant servers and creates a fresh transport after stopping", async () => {
    const { options, kernel } = await setup();
    options.workbench.activePath = () => "index.ts";
    const first = transport(), second = transport();
    const createTransport = vi.fn().mockReturnValueOnce(first.result).mockReturnValueOnce(second.result);
    kernel.contributions.register({ id: "foo.server", kind: "transport", title: "Foo server", data: { languages: ["foo"], createTransport } });
    const language = new LanguageService(options);
    cleanup.push(() => language.dispose());
    expect(language.servers.find(s => s.id === "foo.server")).toBeUndefined();
    expect(createTransport).not.toHaveBeenCalled();
    options.workbench.activePath = () => "main.foo";
    expect(language.servers.find(s => s.id === "foo.server")).toMatchObject({ name: "Foo server", state: "stopped" });
    await language.control("foo.server", "start");
    const selected = language.serviceForPath("main.foo");
    await language.control("foo.server", "stop");
    expect(first.result.dispose).toHaveBeenCalledOnce();
    await language.control("foo.server", "start");
    expect(language.serviceForPath("main.foo")).toBe(selected);
    expect(createTransport).toHaveBeenCalledTimes(2);
    expect(second.result.notify).toHaveBeenCalledWith("textDocument/didOpen", expect.anything());
    expect(language.servers.find(s => s.id === "foo.server")?.state).toBe("ready");
  });
  it("selects a transport by priority and synchronizes its declared language", async () => {
    const { options, kernel, filesystem } = await setup();
    (filesystem as any).shared = new Set(["main.foo"]);
    const low = transport(),
      high = transport();
    kernel.contributions.register({
      id: "foo.low",
      kind: "transport",
      title: "Low",
      data: { languages: ["foo"], createTransport: () => low.result },
    });
    const highRegistration = kernel.contributions.register({
      id: "foo.high",
      kind: "transport",
      title: "High",
      priority: 10,
      data: {
        languages: ["foo"],
        rootUri: "file:///custom",
        createTransport: () => high.result,
      },
    });
    const service = new LanguageService(options);
    cleanup.push(() => service.dispose());
    const selected = service.serviceForPath("main.foo");
    expect(await selected.at("textDocument/completion", "main.foo", 5)).toEqual(
      [{ label: "from foo transport" }],
    );
    expect(high.result.notify).toHaveBeenCalledWith("textDocument/didOpen", {
      textDocument: {
        uri: "file:///custom/main.foo",
        languageId: "foo",
        version: 0,
        text: "hello world",
      },
    });
    expect(kernel.context.get("lsp.completionProvider")).toBe(true);
    expect(low.request).not.toHaveBeenCalled();
    highRegistration.dispose();
    expect(high.result.dispose).toHaveBeenCalledOnce();
    expect(service.serviceForPath("main.foo")).not.toBe(selected);
    expect(kernel.context.get("lsp.completionProvider")).toBe(false);
  });

  it("aborts a removed transport's pending request and factory lifetime", async () => {
    const { options, kernel } = await setup(),
      source = transport();
    let lifetime: AbortSignal | undefined;
    const registration = kernel.contributions.register({
      id: "foo.transport",
      kind: "transport",
      title: "Foo",
      data: {
        languages: ["foo"],
        createTransport: ({ signal }: { signal: AbortSignal }) => {
          lifetime = signal;
          return source.result;
        },
      },
    });
    const service = new LanguageService(options);
    cleanup.push(() => service.dispose());
    const selected = service.serviceForPath("main.foo");
    await selected.start();
    const pending = selected.at("textDocument/hover", "main.foo", 1);
    const rejected = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.waitFor(() =>
      expect(source.request).toHaveBeenCalledWith(
        "textDocument/hover",
        expect.anything(),
        expect.any(AbortSignal),
      ),
    );
    registration.dispose();
    await rejected;
    expect(lifetime?.aborted).toBe(true);
    expect(source.result.dispose).toHaveBeenCalledOnce();
  });

  it("publishes contributed diagnostics and clears them when removed", async () => {
    const { options, kernel } = await setup();
    const events: unknown[] = [];
    kernel.events.on("diagnostics.change", (event) => events.push(event));
    const registration = kernel.contributions.register({
      id: "foo.diagnostics",
      kind: "diagnostics",
      title: "Foo diagnostics",
      data: {
        languages: ["foo"],
        provideDiagnostics: () => [
          { from: 0, to: 5, severity: "warning", message: "Example warning" },
        ],
      },
    });
    const service = new LanguageService(options);
    cleanup.push(() => service.dispose());
    await vi.waitFor(() =>
      expect(service.diagnostics.get("main.foo")).toEqual([
        {
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 5 },
          },
          severity: 2,
          message: "Example warning",
          source: undefined,
        },
      ]),
    );
    registration.dispose();
    expect(service.diagnostics.has("main.foo")).toBe(false);
    expect(events.at(-1)).toEqual({ path: "main.foo", diagnostics: [] });
  });

  it("combines completion providers and cancels work on provider removal", async () => {
    const { options, kernel } = await setup();
    kernel.contributions.register({
      id: "foo.completion",
      kind: "completion",
      title: "Foo completion",
      data: {
        languages: ["foo"],
        provideCompletions: () => [{ label: "hello", insertText: "hello()" }],
      },
    });
    kernel.contributions.register({
      id: "foo.completion.more",
      kind: "completion",
      title: "More",
      data: {
        languages: ["foo"],
        provideCompletions: () => [{ label: "hello" }, { label: "world" }],
      },
    });
    const providers = new LanguageProviders(options, () => {});
    cleanup.push(() => providers.dispose());
    expect(await providers.completions("main.foo", 5)).toEqual([
      { label: "hello", insertText: "hello()" },
      { label: "world" },
    ]);
    let signal: AbortSignal | undefined;
    const registration = kernel.contributions.register({
      id: "foo.pending",
      kind: "completion",
      title: "Pending",
      priority: 20,
      data: {
        languages: ["foo"],
        provideCompletions: (
          _document: unknown,
          _offset: number,
          value: AbortSignal,
        ) => {
          signal = value;
          return new Promise(() => {});
        },
      },
    });
    const pending = providers.completions("main.foo", 5),
      rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(signal).toBeDefined());
    registration.dispose();
    await rejected;
    expect(signal?.aborted).toBe(true);
  });

  it("applies contributed code actions to the unsaved document", async () => {
    const { options, kernel, document, filesystem } = await setup();
    const action: ProviderCodeAction = {
      title: "Change greeting",
      edits: [
        { path: "main.foo", edits: [{ from: 0, to: 5, insert: "goodbye" }] },
      ],
    };
    kernel.contributions.register({
      id: "foo.action",
      kind: "codeAction",
      title: "Foo action",
      data: { languages: ["foo"], provideCodeActions: () => [action] },
    });
    const service = new LanguageService(options);
    cleanup.push(() => service.dispose());
    document.replace("hello unsaved");
    const snapshots = await service.snapshots(false),
      [proposal] = await service.providerCodeActions("main.foo", {
        from: 0,
        to: 5,
      });
    await service.applyProviderCodeAction(
      proposal.owner,
      proposal.action,
      snapshots,
    );
    expect(document.text.toString()).toBe("goodbye unsaved");
    expect(document.dirty).toBe(true);
    expect((await filesystem.read("main.foo")).text).toBe("hello world");
  });

  it("rejects stale document revisions and actions from a replaced provider", async () => {
    const { options, kernel, document } = await setup();
    const action: ProviderCodeAction = {
      title: "Change greeting",
      edits: [
        { path: "main.foo", edits: [{ from: 0, to: 5, insert: "goodbye" }] },
      ],
    };
    const data = { languages: ["foo"], provideCodeActions: () => [action] };
    const registration = kernel.contributions.register({
      id: "foo.action",
      kind: "codeAction",
      title: "Foo action",
      data,
    });
    const service = new LanguageService(options);
    cleanup.push(() => service.dispose());
    const snapshots = await service.snapshots(false),
      [proposal] = await service.providerCodeActions("main.foo", {
        from: 0,
        to: 5,
      });
    document.replace("new content");
    await expect(
      service.applyProviderCodeAction(
        proposal.owner,
        proposal.action,
        snapshots,
      ),
    ).rejects.toThrow();
    expect(document.text.toString()).toBe("new content");
    registration.dispose();
    kernel.contributions.register({
      id: "foo.action",
      kind: "codeAction",
      title: "Replacement",
      data: { ...data },
    });
    await expect(
      service.applyProviderCodeAction(
        proposal.owner,
        proposal.action,
        snapshots,
      ),
    ).rejects.toThrow("removed or replaced");
  });
});

describe("current document server status", () => {
  it("hides unrelated servers when switching documents or leaving the editor", async () => {
    const { kernel, options, workbench } = await setup();
    const foo = transport(), bar = transport();
    kernel.contributions.register({ id: "foo.transport", kind: "transport", title: "Foo", data: { languages: ["foo"], createTransport: () => foo.result } });
    kernel.contributions.register({ id: "bar.transport", kind: "transport", title: "Bar", data: { languages: ["markdown"], createTransport: () => bar.result } });
    const service = new LanguageService(options);
    cleanup.push(() => service.dispose());
    expect(service.servers.map(item => item.name)).toEqual(["Foo"]);
    workbench.activePath = () => "notes.md";
    expect(service.servers.map(item => item.name)).toEqual(["Bar", "Markdown"]);
    workbench.activePath = () => undefined;
    expect(service.servers).toEqual([]);
  });
});
