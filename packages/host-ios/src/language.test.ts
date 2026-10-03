import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createKernel } from "../../core/src/index.js";
import type { IosFileSystem } from "./filesystem.js";
const mocks = vi.hoisted(() => ({ message: vi.fn() }));
vi.mock("./native.js", () => ({ native: { lspMessage: mocks.message } }));
import { createIosLanguageFeature, IosLanguageTransport } from "./language.js";

const transports: IosLanguageTransport[] = [];
const payload = (result: unknown = null, notifications: unknown[] = []) => ({ payload: JSON.stringify({ result, notifications }) });
beforeEach(() => { mocks.message.mockReset(); mocks.message.mockResolvedValue(payload()); });
afterEach(() => { for (const transport of transports.splice(0)) transport.dispose(); });
function transport() {
  const result = new IosLanguageTransport("ios:workspace", "typescript");
  transports.push(result);
  return result;
}

describe("native iOS LSP transport", () => {
  it("orders initialization, changes, and requests while delivering native diagnostics", async () => {
    let initialize!: (value: { payload: string }) => void;
    mocks.message.mockImplementationOnce(() => new Promise(resolve => { initialize = resolve; }));
    const lsp = transport(), notifications = vi.fn();
    lsp.onNotification(notifications);
    const started = lsp.request("initialize", {});
    lsp.notify("textDocument/didOpen", { textDocument: { text: "unsaved" } });
    const hovered = lsp.request("textDocument/hover", { textDocument: { uri: "file:///workspace/main.ts" } });
    await vi.waitFor(() => expect(mocks.message).toHaveBeenCalledTimes(1));
    mocks.message.mockResolvedValueOnce(payload(null, [{ method: "textDocument/publishDiagnostics", params: { diagnostics: [{ message: "Error" }] } }])).mockResolvedValueOnce(payload({ contents: "number" }));
    initialize(payload({ capabilities: { hoverProvider: true } }));
    await expect(started).resolves.toMatchObject({ capabilities: { hoverProvider: true } });
    await expect(hovered).resolves.toEqual({ contents: "number" });
    expect(mocks.message.mock.calls.map(([message]) => message.method)).toEqual(["initialize", "textDocument/didOpen", "textDocument/hover"]);
    expect(notifications).toHaveBeenCalledWith("textDocument/publishDiagnostics", { diagnostics: [{ message: "Error" }] });
    expect(mocks.message.mock.calls.every(([message]) => message.workspaceId === "ios:workspace" && message.kind === "typescript")).toBe(true);
  });

  it("cancels queued requests before sending them and rejects active requests on disposal", async () => {
    let complete!: (value: { payload: string }) => void;
    mocks.message.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const lsp = transport(), controller = new AbortController();
    const started = lsp.request("initialize", {});
    const queued = lsp.request("textDocument/hover", {}, controller.signal);
    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(mocks.message).toHaveBeenCalledTimes(1));
    lsp.dispose();
    await expect(started).rejects.toThrow("disposed");
    complete(payload());
    await vi.waitFor(() => expect(mocks.message).toHaveBeenCalledWith(expect.objectContaining({ method: "exit" })));
    expect(mocks.message.mock.calls.some(([message]) => message.method === "textDocument/hover")).toBe(false);
    await expect(lsp.request("initialize", {})).rejects.toThrow("disposed");
  });

  it("surfaces native request failures and notification failures in LSP status", async () => {
    const lsp = transport(), notifications = vi.fn();
    lsp.onNotification(notifications);
    mocks.message.mockResolvedValueOnce({ payload: JSON.stringify({ error: { code: -32603, message: "Cannot load language server" }, notifications: [] }) });
    await expect(lsp.request("initialize", {})).rejects.toThrow("Cannot load language server");
    mocks.message.mockRejectedValueOnce(new Error("Folder is closed"));
    lsp.notify("textDocument/didChange", {});
    await vi.waitFor(() => expect(notifications).toHaveBeenCalledWith("oxbit/serverState", { state: "stopped", error: "Error: Folder is closed" }));
  });

  it("registers device providers, starts restored documents, and disposes them with the feature", async () => {
    const kernel = createKernel();
    let changed!: (change: { path: string; kind: "changed" }) => void;
    const unwatch = vi.fn();
    const filesystem = { id: "ios:workspace", root: "/workspace folder", watch: (listener: typeof changed) => { changed = listener; return { dispose: unwatch }; } } as unknown as IosFileSystem;
    const lsp = transport(), start = vi.fn().mockResolvedValue(undefined);
    kernel.services.register("documents", { documents: new Map([["main.ts", { path: "main.ts" }]]) });
    kernel.services.register("language", {
      servicesForPath: () => kernel.contributions.list("transport").length ? [{ transport: lsp, state: "stopped", start }] : [],
    });
    const feature = createIosLanguageFeature(filesystem);
    kernel.extensions.register(feature);
    await kernel.extensions.activate(feature.manifest.id);
    const providers = kernel.contributions.list("transport");
    expect(providers.map(provider => provider.id).sort()).toEqual(["language.ios.json", "language.ios.typescript"]);
    const provider = providers.find(provider => provider.id === "language.ios.typescript")!;
    expect(provider.data.rootUri).toBe("file:///workspace%20folder");
    expect(start).toHaveBeenCalledOnce();
    const controller = new AbortController();
    const nativeTransport = provider.data.createTransport({ workspaceId: filesystem.id, signal: controller.signal }) as IosLanguageTransport;
    await nativeTransport.request("initialize", {});
    changed({ path: "dependency.ts", kind: "changed" });
    await vi.waitFor(() => expect(mocks.message).toHaveBeenCalledWith(expect.objectContaining({ method: "workspace/didChangeWatchedFiles", params: { changes: [{ uri: "file:///workspace%20folder/dependency.ts", type: 2 }] } })));
    kernel.events.emit("document.open", { path: "next.ts" });
    expect(start).toHaveBeenCalledTimes(2);
    await kernel.extensions.disable(feature.manifest.id);
    expect(kernel.contributions.list("transport")).toEqual([]);
    expect(unwatch).toHaveBeenCalledOnce();
    await expect(nativeTransport.request("initialize", {})).rejects.toThrow("disposed");
    kernel.dispose();
  });
});
