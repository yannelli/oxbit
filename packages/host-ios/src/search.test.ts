import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));

const { IosFileSystem, SshFileSystem } = await import("./index.js");
const root = { id: "ios:abc", root: "/tmp/root", name: "root" };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

beforeEach(() => invoke.mockReset());

describe("native workspace search", () => {
  it("sends content search and quick open to the Rust host", async () => {
    const filesystem = new IosFileSystem(root);
    invoke.mockResolvedValueOnce({ matches: [], truncated: false });
    await filesystem.search!({ query: "needle", regex: true, include: "*.ts" });
    const [command, args] = invoke.mock.calls[0]!;
    expect(command).toBe("ios_search_request");
    expect(args).toMatchObject({ id: "ios:abc", method: "search", params: { query: "needle", regex: true, include: "*.ts" } });
    expect(args.requestId).toMatch(uuid);
    invoke.mockResolvedValueOnce(["src/a.ts"]);
    expect(await filesystem.findFiles!("sa")).toEqual(["src/a.ts"]);
    expect(invoke.mock.calls[1]![1]).toMatchObject({ method: "files", params: { query: "sa" } });
  });
  it("cancels the native request when the signal aborts", async () => {
    let finish!: (value: unknown) => void;
    invoke.mockImplementation((command: string) =>
      command === "ios_search_request" ? new Promise(resolve => { finish = resolve; }) : Promise.resolve());
    const controller = new AbortController();
    const pending = new IosFileSystem(root).findFiles!("a", controller.signal);
    controller.abort();
    finish([]);
    await expect(pending).rejects.toThrow();
    const requestId = invoke.mock.calls[0]![1].requestId;
    expect(invoke).toHaveBeenCalledWith("ios_search_cancel", { id: "ios:abc", requestId }, undefined);
  });
  it("leaves SFTP roots on the workbench walk", () => {
    const filesystem = new SshFileSystem(root, "host");
    expect(filesystem.search).toBeUndefined();
    expect(filesystem.findFiles).toBeUndefined();
  });
});
