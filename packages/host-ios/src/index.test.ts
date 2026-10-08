import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RpcError } from "@oxbit/protocol";

const invoke = vi.fn();
const listeners = new Map<string, (event: { payload: unknown }) => void>();
const unlisten = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(name, handler);
    return unlisten;
  },
}));

const { IosFileSystem, IosPersistence, SshFileSystem, ssh, revisionOf, toError, rememberWorkspace, RECENTS_LIMIT } = await import("./index.js");
const root = { id: "ios:abc", root: "/tmp/root", name: "root" };
const encoder = new TextEncoder();

beforeEach(() => {
  invoke.mockReset();
  unlisten.mockReset();
  listeners.clear();
});

describe("IosFileSystem", () => {
  it("waits for native workspace cleanup before closing folder access", async () => {
    let finish!: () => void;
    invoke.mockImplementation(command => command === "ios_fs_close_root" ? new Promise<void>(resolve => { finish = resolve; }) : undefined);
    const filesystem = new IosFileSystem(root);
    filesystem.dispose();
    const closed = filesystem.close();
    let complete = false;
    void closed.then(() => { complete = true; });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("ios_fs_close_root", { id: "ios:abc" }, undefined));
    expect(complete).toBe(false);
    finish();
    await closed;
    expect(complete).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it("decodes bytes and reports the SHA-256 revision", async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...encoder.encode("a\r\nb")]);
    invoke.mockResolvedValueOnce(bytes.buffer);
    const snapshot = await new IosFileSystem(root).read("src/./a.txt");
    expect(invoke).toHaveBeenCalledWith("ios_fs_read", { id: "ios:abc", path: "src/a.txt" }, undefined);
    expect(snapshot).toMatchObject({ path: "src/a.txt", text: "a\nb", encoding: "utf-8-bom", eol: "CRLF" });
    expect(snapshot.revision).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(await revisionOf(bytes)).toBe(snapshot.revision);
  });
  it("encodes writes with the remembered encoding and sends the expected revision header", async () => {
    const fs = new IosFileSystem(root);
    invoke.mockResolvedValueOnce(new Uint8Array([0xff, 0xfe, 0x61, 0x00]).buffer);
    await fs.read("a.txt");
    invoke.mockResolvedValueOnce({ revision: "r2", size: 6 });
    const result = await fs.write("a.txt", "ab", { expectedRevision: "r1", eol: "CRLF" });
    const [command, body, options] = invoke.mock.calls[1]!;
    expect(command).toBe("ios_fs_write");
    expect([...(body as Uint8Array)]).toEqual([0xff, 0xfe, 0x61, 0x00, 0x62, 0x00]);
    expect(options).toEqual({ headers: { "x-oxbit-root": "ios:abc", "x-oxbit-path": "a.txt", "x-oxbit-expected": "r1" } });
    expect(result).toMatchObject({ revision: "r2", encoding: "utf-16le", eol: "CRLF" });
  });
  it("rejects paths that escape the root before calling native code", async () => {
    await expect(new IosFileSystem(root).read("../etc/passwd")).rejects.toThrow(/Invalid workspace path/);
    expect(invoke).not.toHaveBeenCalled();
  });
  it("maps native errors to RpcError with the runtime code", async () => {
    invoke.mockRejectedValueOnce({ code: "CONFLICT", message: "File revision conflict: a.txt" });
    const error = await new IosFileSystem(root).write("a.txt", "x", { expectedRevision: "old" }).catch((e) => e);
    expect(error).toBeInstanceOf(RpcError);
    expect(error.code).toBe("CONFLICT");
    expect(toError("ENOENT: no such file").message).toContain("ENOENT");
  });
  it("starts one native watcher for many listeners and stops after the last dispose", async () => {
    invoke.mockResolvedValue(undefined);
    const fs = new IosFileSystem(root);
    const seen: unknown[] = [];
    const first = fs.watch((event) => seen.push(event));
    const second = fs.watch((event) => seen.push(event));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(invoke.mock.calls.filter(([command]) => command === "ios_fs_watch")).toHaveLength(1);
    listeners.get("ios-fs-change:ios:abc")!({ payload: { path: "a.txt", kind: "changed" } });
    expect(seen).toEqual([{ path: "a.txt", kind: "changed" }, { path: "a.txt", kind: "changed" }]);
    first.dispose();
    expect(unlisten).not.toHaveBeenCalled();
    second.dispose();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("ios_fs_unwatch", { id: "ios:abc" }, undefined);
  });
});

describe("SshFileSystem", () => {
  it("routes file operations to the SFTP commands and writes the raw body", async () => {
    invoke.mockResolvedValueOnce(root);
    const fs = await SshFileSystem.connect("host-1", "~/project");
    expect(invoke).toHaveBeenCalledWith("ios_ssh_open_root", { hostId: "host-1", path: "~/project" }, undefined);
    expect(fs.hostId).toBe("host-1");
    invoke.mockResolvedValueOnce([]);
    await fs.list("src");
    expect(invoke).toHaveBeenLastCalledWith("ios_ssh_fs_list", { id: "ios:abc", path: "src" }, undefined);
    invoke.mockResolvedValueOnce({ revision: "r2", size: 1 });
    await fs.write("a.txt", "x", { expectedRevision: null });
    const [command, body, options] = invoke.mock.calls.at(-1)!;
    expect(command).toBe("ios_ssh_fs_write");
    expect([...(body as Uint8Array)]).toEqual([0x78]);
    expect(options).toEqual({ headers: { "x-oxbit-root": "ios:abc", "x-oxbit-path": "a.txt", "x-oxbit-expected": "" } });
    await fs.rename("a.txt", "b/c.txt");
    expect(invoke).toHaveBeenLastCalledWith("ios_ssh_fs_rename", { id: "ios:abc", path: "a.txt", to: "b/c.txt" }, undefined);
  });
  it("starts no native watcher and closes the SFTP root once", async () => {
    invoke.mockResolvedValue(undefined);
    const fs = new SshFileSystem(root, "host-1");
    fs.watch(() => {}).dispose();
    await Promise.all([fs.close(), fs.dispose()]);
    expect(invoke.mock.calls.map(([command]) => command)).toEqual(["ios_ssh_close_root"]);
    expect(listeners.size).toBe(0);
  });
  it("returns key metadata lists from the plugin and passes trust arguments", async () => {
    const key = { id: "k", name: "Phone", algorithm: "ssh-ed25519", fingerprint: "SHA256:x", publicKey: "ssh-ed25519 AAAA" };
    invoke.mockResolvedValueOnce({ keys: [key] });
    expect(await ssh.keys()).toEqual([key]);
    expect(invoke).toHaveBeenLastCalledWith("plugin:oxbit-files|ssh_keys", { request: { operation: "list" } }, undefined);
    await ssh.trust("host-1", { algorithm: "ssh-ed25519", fingerprint: "SHA256:x" });
    expect(invoke).toHaveBeenLastCalledWith("ios_ssh_trust", { hostId: "host-1", algorithm: "ssh-ed25519", fingerprint: "SHA256:x" }, undefined);
  });
});

describe("IosPersistence", () => {
  it("routes profile settings to the shared profile scope and serializes writes", async () => {
    const order: string[] = [];
    invoke.mockImplementation(async (command: string, args: { key: string }) => {
      order.push(`${command}:${args.key}`);
      return null;
    });
    const persistence = new IosPersistence("ios:abc");
    void persistence.set("layout:ios:abc", { a: 1 });
    void persistence.set("profile-settings", { user: {} });
    await persistence.delete("documents:ios:abc");
    expect(order).toEqual(["ios_storage_set:layout:ios:abc", "ios_storage_set:profile-settings", "ios_storage_set:documents:ios:abc"]);
    expect(invoke).toHaveBeenCalledWith("ios_storage_set", { scope: "profile", key: "profile-settings", value: { user: {} } }, undefined);
    expect(invoke).toHaveBeenCalledWith("ios_storage_set", { scope: "ios:abc", key: "documents:ios:abc", value: null }, undefined);
    expect(await persistence.get("missing")).toBeUndefined();
  });
});

describe("recents", () => {
  it("dedupes by id, keeps newest first, and caps the list", async () => {
    const existing = Array.from({ length: RECENTS_LIMIT }, (_, index) => ({ id: `w${index}`, kind: "bookmark" as const, name: `w${index}`, lastOpened: index }));
    invoke.mockResolvedValueOnce(existing).mockResolvedValueOnce(undefined);
    const next = await rememberWorkspace({ id: "w3", kind: "bookmark", name: "renamed" });
    expect(next).toHaveLength(RECENTS_LIMIT);
    expect(next[0]).toMatchObject({ id: "w3", name: "renamed" });
    expect(next.filter((item) => item.id === "w3")).toHaveLength(1);
    expect(next.some((item) => item.id === "w0")).toBe(true);
    invoke.mockResolvedValueOnce(next).mockResolvedValueOnce(undefined);
    const capped = await rememberWorkspace({ id: "fresh", kind: "documents", name: "Oxbit" });
    expect(capped).toHaveLength(RECENTS_LIMIT);
    expect(capped[0]!.id).toBe("fresh");
    expect(capped.some((item) => item.id === "w0")).toBe(false);
  });
});
