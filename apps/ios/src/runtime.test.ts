import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ credentials: vi.fn(), connect: vi.fn(), dispose: vi.fn(), constructor: vi.fn() }));
vi.mock("@oxbit/host-ios", () => ({ native: { runtimeCredentials: mocks.credentials } }));
vi.mock("@oxbit/app-workbench", () => ({
  RuntimeClient: class {
    connect = mocks.connect;
    dispose = mocks.dispose;
    constructor(...args: unknown[]) { mocks.constructor(...args); }
  },
}));
import { connectRuntime, runtimeScope, runtimeUrl } from "./runtime.js";
import type { RuntimeClient } from "@oxbit/app-workbench";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.credentials.mockResolvedValue({ token: "native-test-token" });
  mocks.connect.mockResolvedValue(undefined);
});

describe("iOS runtime connection", () => {
  it("normalizes runtime addresses and rejects embedded secrets or unrelated paths", () => {
    expect(runtimeUrl(" HTTP://192.168.1.10:9277/ ")).toBe("http://192.168.1.10:9277");
    expect(runtimeUrl("https://computer.local:443")).toBe("https://computer.local");
    for (const url of ["computer", "file:///tmp", "https://user:password@computer", "https://computer/project", "https://computer?token=secret", "https://computer#pair=secret"])
      expect(() => runtimeUrl(url)).toThrow();
  });

  it("pairs through the native host and keeps the token out of WebView storage", async () => {
    await connectRuntime("http://computer.local:9277/", " owner-code ");
    expect(mocks.credentials).toHaveBeenCalledWith({ operation: "pair", url: "http://computer.local:9277", code: "owner-code" });
    expect(mocks.constructor).toHaveBeenCalledWith("http://computer.local:9277", "default", { token: "native-test-token", persistToken: false });
    expect(mocks.connect).toHaveBeenCalledOnce();
  });

  it("reuses Keychain credentials without pairing again", async () => {
    await connectRuntime("http://computer.local:9277");
    expect(mocks.credentials).toHaveBeenCalledWith({ operation: "get", url: "http://computer.local:9277", code: undefined });
  });

  it("asks for a pairing code when no credential is saved", async () => {
    mocks.credentials.mockResolvedValue({});
    await expect(connectRuntime("http://computer.local:9277")).rejects.toThrow("pairing code");
    expect(mocks.constructor).not.toHaveBeenCalled();
  });

  it("stops a failed client so background retries cannot outlive the connection attempt", async () => {
    mocks.connect.mockRejectedValue(new Error("Cannot connect to runtime"));
    await expect(connectRuntime("http://computer.local:9277")).rejects.toThrow("Cannot connect");
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });

  it("keeps drafts scoped to the remote workspace, with a filesystem-safe identity", async () => {
    const remote = (key: string, port = 9277) => ({ url: `http://computer.local:${port}`, workspaceId: "default", session: { workspaceKey: key } }) as RuntimeClient;
    const first = await runtimeScope(remote("project-one"));
    expect(first).toMatch(/^ios:[a-f0-9]{64}$/);
    expect(await runtimeScope(remote("project-one", 9278))).toBe(first);
    expect(await runtimeScope(remote("project-two"))).not.toBe(first);
    expect(await runtimeScope({ ...remote("project-one"), url: "http://another-computer.local:9277" } as RuntimeClient)).not.toBe(first);
  });
});
