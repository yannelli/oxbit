import { afterEach, describe, expect, it, vi } from "vitest";
import { createKernel } from "../../../core/src/index";
import {
  BrowserFileSystem,
  MemoryPersistence,
} from "../../../host-browser/src/index";
import { DocumentService } from "../../../documents/src/index";
import type { FeatureOptions, LanguageTransport } from "@oxbit/sdk";
import { LanguageService } from "./index.js";
import { documentSymbols } from "./symbols.js";

const range = (line: number, character = 0) => ({
  start: { line, character },
  end: { line, character: character + 3 },
});
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
});

async function setup(capabilities = { documentSymbolProvider: true }) {
  const kernel = createKernel(),
    persistence = new MemoryPersistence();
  const filesystem = new BrowserFileSystem(persistence);
  await filesystem.write("main.foo", "class Ledger {}", {
    expectedRevision: null,
  });
  const documents = new DocumentService(filesystem, persistence, kernel);
  const workbench = {
    activePath: () => "main.foo",
    notify: vi.fn(),
  } as unknown as FeatureOptions["workbench"];
  const request = vi.fn(
    async (
      method: string,
      _params: unknown,
      _signal?: AbortSignal,
    ): Promise<any> => {
      if (method === "initialize") return { capabilities };
      if (method === "textDocument/documentSymbol")
        return [
          {
            name: "Ledger",
            kind: 5,
            range: range(0),
            selectionRange: range(0, 6),
          },
        ];
      return null;
    },
  );
  const transport: LanguageTransport = {
    request,
    notify: vi.fn(),
    onNotification: () => ({ dispose() {} }),
    dispose() {},
  };
  kernel.contributions.register({
    id: "foo",
    kind: "language",
    title: "Foo",
    data: { id: "foo", extensions: [".foo"] },
  });
  kernel.contributions.register({
    id: "foo.server",
    kind: "transport",
    title: "Foo server",
    data: {
      languages: ["foo"],
      rootUri: "file:///custom%20project",
      createTransport: () => transport,
    },
  });
  const service = new LanguageService({
    kernel,
    filesystem,
    documents,
    workbench,
  });
  cleanup.push(
    () => kernel.dispose(),
    () => documents.dispose(),
    () => service.dispose(),
  );
  return { service, request, documents };
}

describe("document symbols", () => {
  it("normalizes nested and flat symbols with safe navigation ranges", () => {
    expect(
      documentSymbols(
        [
          {
            name: "Ledger",
            kind: 5,
            range: range(0),
            selectionRange: range(0, 6),
            children: [{ name: "add", kind: 6, range: range(2) }],
          },
          {
            name: "other",
            kind: 13,
            location: { uri: "file:///other.ts", range: range(8) },
          },
        ],
        "main.ts",
        (uri) => uri.slice(8),
      ),
    ).toMatchObject([
      {
        name: "Ledger",
        path: "main.ts",
        depth: 0,
        selectionRange: range(0, 6),
      },
      { name: "add", path: "main.ts", depth: 1, selectionRange: range(2) },
      { name: "other", path: "other.ts", depth: 0, selectionRange: range(8) },
    ]);
    expect(
      documentSymbols(
        [
          null,
          { name: "bad", range: range(-1) },
          { name: "external", location: { uri: "outside", range: range(0) } },
        ],
        "main.ts",
        () => {
          throw new Error("Outside workspace");
        },
      ),
    ).toEqual([]);
    expect(documentSymbols(null, "main.ts", () => "")).toEqual([]);
  });
  it("selects a contributed server and initializes before constructing the URI", async () => {
    const { service, request } = await setup();
    expect(await service.symbols("main.foo")).toMatchObject([
      { name: "Ledger", path: "main.foo", kind: 5 },
    ]);
    const methods = request.mock.calls.map(([method]) => method);
    expect(methods.indexOf("initialize")).toBeLessThan(
      methods.indexOf("textDocument/documentSymbol"),
    );
    expect(request).toHaveBeenCalledWith(
      "textDocument/documentSymbol",
      { textDocument: { uri: "file:///custom%20project/main.foo" } },
      expect.any(AbortSignal),
    );
  });
  it("reports unsupported servers and stopped servers instead of an empty outline", async () => {
    const { service } = await setup({ documentSymbolProvider: false });
    await expect(service.symbols("main.foo")).rejects.toThrow(
      "does not provide document symbols",
    );
    await service.serviceForPath("main.foo").stop();
    await expect(service.symbols("main.foo")).rejects.toThrow(
      "Language server is stopped",
    );
    await expect(service.symbols("notes.md")).rejects.toThrow("runtime workspace");
  });
  it("rejects cancelled requests and stale responses after an unsaved edit", async () => {
    const { service, request, documents } = await setup();
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(
      service.symbols("main.foo", cancelled.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    await service.symbols("main.foo");
    let resolve!: (value: unknown) => void;
    request.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const pending = service.symbols("main.foo");
    await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    documents.get("main.foo")!.replace("class Changed {}");
    resolve([{ name: "Ledger", kind: 5, range: range(0) }]);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
