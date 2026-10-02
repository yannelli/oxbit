import { afterEach, describe, expect, it, vi } from "vitest";
import type { FeatureOptions, FileChange, GitStatus, Kernel } from "@oxbit/sdk";
import { createKernel } from "../../../core/src/index.js";
import { createFeature } from "./index.js";

const kernels: Kernel[] = [];
afterEach(() => {
  for (const kernel of kernels.splice(0)) kernel.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function repositoryStatus(): GitStatus {
  return {
    repository: true,
    branch: "main",
    branches: ["main"],
    refs: [],
    changes: [{ path: "hello.txt", index: " ", working: "M" }],
    remotes: [],
    ahead: 0,
    behind: 0,
  };
}

function createClient() {
  const listeners = new Map<string, (params: any) => void>();
  return {
    connected: true,
    request: vi.fn(async (method: string): Promise<any> =>
      method === "git.status" ? repositoryStatus() : {},
    ),
    subscribe: vi.fn((event: string, listener: (params: any) => void) => {
      listeners.set(event, listener);
      return () => listeners.delete(event);
    }),
    listeners,
  };
}

interface GitService {
  status(): GitStatus;
  refresh(): Promise<void>;
  stage(path: string): Promise<void>;
  commit(message: string): Promise<void>;
  subscribe(listener: () => void): () => void;
}

async function setup({
  native = true,
  runtime = false,
  autoFetch = false,
} = {}) {
  const kernel = createKernel();
  kernels.push(kernel);
  kernel.configuration.register({
    id: "scm.autoFetch",
    title: "Auto Fetch",
    type: "boolean",
    default: autoFetch,
  });
  const nativeClient = createClient(),
    runtimeClient = createClient(),
    fileListeners = new Set<(event: FileChange) => void>();
  const filesystem = {
    id: native ? "ios:workspace" : "runtime:workspace",
    watch: vi.fn((listener: (event: FileChange) => void) => {
      fileListeners.add(listener);
      return { dispose: () => fileListeners.delete(listener) };
    }),
  };
  const workbench = {
    activePath: () => "hello.txt",
    ask: vi.fn(),
    prompt: vi.fn(),
    notify: vi.fn(),
    openPanel: vi.fn(),
    refreshFiles: vi.fn(),
  };
  const options = {
    kernel,
    git: native ? nativeClient : undefined,
    runtime: runtime ? runtimeClient : undefined,
    filesystem,
    documents: { documents: new Map(), get: vi.fn() },
    workbench,
  } as unknown as FeatureOptions;
  const feature = createFeature(options);
  kernel.extensions.register(feature);
  await kernel.extensions.activate(feature.manifest.id);
  return {
    kernel,
    nativeClient,
    runtimeClient,
    filesystem,
    fileListeners,
    workbench,
    service: kernel.services.get<GitService>("git"),
  };
}

describe("Git transport", () => {
  it("uses native Git requests while a runtime is disconnected", async () => {
    const { nativeClient, runtimeClient, service, kernel } = await setup({
      runtime: true,
    });
    runtimeClient.connected = false;
    await service.refresh();
    await service.stage("hello.txt");
    await service.commit("Update greeting");
    expect(service.status().branch).toBe("main");
    expect(kernel.context.get("gitRepo")).toBe(true);
    expect(nativeClient.request).toHaveBeenCalledWith(
      "git.stage",
      { path: "hello.txt" },
      { signal: undefined },
    );
    expect(nativeClient.request).toHaveBeenCalledWith(
      "git.commit",
      { message: "Update greeting" },
      { signal: undefined },
    );
    expect(runtimeClient.request).not.toHaveBeenCalled();
    expect(runtimeClient.subscribe).not.toHaveBeenCalled();
  });

  it("rejects requests when native Git is disconnected", async () => {
    const { nativeClient, runtimeClient, service } = await setup({
      runtime: true,
    });
    nativeClient.connected = false;
    await expect(service.refresh()).rejects.toThrow(
      "Source control is unavailable for this workspace",
    );
    expect(nativeClient.request).not.toHaveBeenCalled();
    expect(runtimeClient.request).not.toHaveBeenCalled();
  });

  it("retains runtime requests, filesystem events, and connection errors", async () => {
    vi.useFakeTimers();
    const { runtimeClient, filesystem, service } = await setup({
      native: false,
      runtime: true,
    });
    await service.refresh();
    expect(filesystem.watch).not.toHaveBeenCalled();
    runtimeClient.listeners.get("fs.change")!({ path: "hello.txt" });
    await vi.advanceTimersByTimeAsync(300);
    expect(runtimeClient.request).toHaveBeenCalledTimes(2);
    expect(runtimeClient.request).toHaveBeenCalledWith(
      "git.status",
      {},
      { signal: undefined },
    );
    runtimeClient.connected = false;
    await expect(service.refresh()).rejects.toThrow(
      "Connect to a trusted runtime workspace to use Git",
    );
  });

  it("debounces native filesystem refresh and disposes watches and pending refresh", async () => {
    vi.useFakeTimers();
    const { nativeClient, fileListeners, service, kernel } = await setup();
    await service.refresh();
    const emit = () => {
      for (const listener of fileListeners)
        listener({ path: "hello.txt", kind: "changed" });
    };
    emit();
    emit();
    await vi.advanceTimersByTimeAsync(299);
    expect(nativeClient.request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(nativeClient.request).toHaveBeenCalledTimes(2);
    emit();
    await kernel.extensions.disable("oxbit.git");
    expect(fileListeners.size).toBe(0);
    expect(nativeClient.listeners.size).toBe(0);
    await vi.advanceTimersByTimeAsync(300);
    expect(nativeClient.request).toHaveBeenCalledTimes(2);
    await kernel.extensions.activate("oxbit.git");
    expect(fileListeners.size).toBe(1);
    expect(nativeClient.listeners.size).toBe(3);
  });

  it("uses native connection events for auto-fetch and native operation recovery", async () => {
    vi.useFakeTimers();
    const { nativeClient, runtimeClient, workbench } = await setup({
      runtime: true,
      autoFetch: true,
    });
    runtimeClient.connected = false;
    await vi.advanceTimersByTimeAsync(60000);
    expect(nativeClient.request).toHaveBeenCalledWith(
      "git.fetch",
      {},
      { signal: expect.any(AbortSignal) },
    );
    nativeClient.connected = false;
    nativeClient.listeners.get("connection.change")!({ state: "disconnected" });
    await vi.advanceTimersByTimeAsync(60000);
    expect(nativeClient.request).toHaveBeenCalledTimes(2);
    nativeClient.connected = true;
    nativeClient.listeners.get("connection.change")!({ state: "connected" });
    await vi.advanceTimersByTimeAsync(0);
    expect(nativeClient.request).toHaveBeenCalledTimes(3);
    nativeClient.listeners.get("operation.recovered")!({
      method: "git.push",
      status: "completed",
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(nativeClient.request).toHaveBeenCalledTimes(4);
    expect(workbench.notify).toHaveBeenCalledWith(
      "git.push: operation completed after reconnect",
    );
    expect(runtimeClient.request).not.toHaveBeenCalled();
  });

  it("updates subscribers from native progress events", async () => {
    const { nativeClient, service } = await setup(),
      changed = vi.fn();
    const unsubscribe = service.subscribe(changed);
    nativeClient.listeners.get("git.progress")!({ data: "Receiving objects" });
    expect(changed).toHaveBeenCalledTimes(1);
    unsubscribe();
    nativeClient.listeners.get("git.progress")!({ data: "Done" });
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("refreshes native Git on focus and removes the focus listener on disposal", async () => {
    vi.useFakeTimers();
    const window = new EventTarget();
    vi.stubGlobal("window", window);
    const { nativeClient, service, kernel } = await setup();
    await service.refresh();
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(nativeClient.request).toHaveBeenCalledTimes(2);
    nativeClient.connected = false;
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(nativeClient.request).toHaveBeenCalledTimes(2);
    nativeClient.connected = true;
    await kernel.extensions.disable("oxbit.git");
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(nativeClient.request).toHaveBeenCalledTimes(2);
  });
});
