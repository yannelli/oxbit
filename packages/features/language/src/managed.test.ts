import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import type { FeatureOptions, RpcClient } from "@oxbit/sdk";
import { createKernel } from "../../../core/src/index";
import { DocumentService } from "../../../documents/src/index";
import { BrowserFileSystem, MemoryPersistence } from "../../../host-browser/src/index";
import { LanguageService } from "./index";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
});

const controller = "app/Http/Controllers/PatientChartProposalsController.php";
const ready = { capabilities: { hoverProvider: true }, rootUri: "file:///workspace" };

async function laravel(lifecycle: (method: string, definitionId: string) => Promise<any> | any = () => undefined) {
  const kernel = createKernel(), persistence = new MemoryPersistence();
  const filesystem = new BrowserFileSystem(persistence);
  for (const [path, text] of [["artisan", "<?php\n"], ["composer.json", "{}"], [controller, "<?php\nclass PatientChartProposalsController {}\n"]])
    await filesystem.write(path, text, { expectedRevision: null });
  const documents = new DocumentService(filesystem, persistence, kernel);
  await documents.open(controller);
  const subscribers = new Map<string, Set<(value: any) => void>>();
  const instances = new Map<string, string>();
  const request = vi.fn(async (method: string, params: Record<string, any> = {}): Promise<any> => {
    if (method === "lsp.attach") {
      instances.set(`${params.definitionId}:1`, params.definitionId);
      return { instanceId: `${params.definitionId}:1`, name: params.definitionId === "laravel" ? "Laravel" : "Intelephense", ...(await lifecycle("status", params.definitionId) ?? { state: "stopped" }) };
    }
    if (method === "lsp.start") return await lifecycle("start", instances.get(params.instanceId)!) ?? ready;
    if (["lsp.notify", "lsp.detach", "lsp.stop"].includes(method)) return null;
    throw new Error(`Unexpected method ${method}`);
  });
  const runtime = {
    connected: true, request,
    subscribe(event: string, listener: (value: any) => void) {
      const listeners = subscribers.get(event) ?? new Set();
      listeners.add(listener); subscribers.set(event, listeners);
      return () => { listeners.delete(listener); };
    },
  } as unknown as RpcClient;
  const workbench = { activePath: () => controller, notify: vi.fn(), refreshFiles: vi.fn() } as unknown as FeatureOptions["workbench"];
  const language = new LanguageService({ kernel, filesystem, documents, runtime, workbench } as unknown as FeatureOptions);
  cleanup.push(() => language.dispose(), () => documents.dispose(), () => kernel.dispose());
  const started = (definitionId: string) => request.mock.calls.some(([method, params]) => method === "lsp.start" && instances.get(params?.instanceId) === definitionId);
  return { language, request, started };
}

describe("managed PHP servers in a Laravel project", () => {
  it("names each server and starts Laravel when the artisan lookup finishes after the editor opened", async () => {
    const { language, started } = await laravel();
    const [intelephense] = language.servicesForPath(controller);
    expect(language.servers.map(server => [server.name, server.state])).toEqual([["Intelephense", "stopped"]]);
    (intelephense as any).views.set(controller, new Set([{ state: EditorState.create({ doc: "<?php\n" }), dispatch: vi.fn() }]));
    await vi.waitFor(() => expect(language.servers.map(server => server.name)).toEqual(["Intelephense", "Laravel"]));
    await vi.waitFor(() => expect(started("laravel")).toBe(true));
    await vi.waitFor(() => expect(language.servers.find(server => server.name === "Laravel")?.state).toBe("ready"));
  });

  it("keeps the runtime's failure reason when the status refreshes", async () => {
    const reason = "Laravel needs PHP on the runtime host.";
    const { language } = await laravel((method, id) => id === "laravel" && method === "status" ? { state: "failed", error: reason } : undefined);
    await vi.waitFor(() => expect(language.servers.map(server => server.name)).toEqual(["Intelephense", "Laravel"]));
    await language.refreshStatus();
    expect(language.servers.find(server => server.name === "Laravel")).toMatchObject({ state: "failed", error: reason });
  });

  it("follows a start that another client began until the runtime finishes it", async () => {
    let finish!: () => void;
    const finished = new Promise<void>(resolve => { finish = resolve; });
    const { language, started } = await laravel(async (method, id) => {
      if (id !== "intelephense") return undefined;
      if (method === "status") return { state: "installing" };
      await finished;
      return ready;
    });
    await language.refreshStatus();
    expect(started("intelephense")).toBe(true);
    expect(language.servers[0]?.state).toBe("starting");
    finish();
    await vi.waitFor(() => expect(language.servers[0]?.state).toBe("ready"));
  });

  it("ends a start that outlives the runtime request in a failed state with a reason", async () => {
    const { language } = await laravel(method => {
      if (method === "start") throw Object.assign(new Error("Operation 1 timed out; inspect its status"), { code: "TIMEOUT" });
    });
    const [intelephense] = language.servicesForPath(controller);
    await expect(intelephense!.start()).rejects.toThrow("timed out");
    expect(language.servers[0]).toMatchObject({ state: "failed", error: "Timed out waiting for the runtime to start this language server. Retry to check it again." });
  });
});
