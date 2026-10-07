import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IosGitClient } from "./git.js";
import { native } from "./native.js";

const { invoke, listen, unlisten, progress } = vi.hoisted(() => ({
  invoke: vi.fn(), listen: vi.fn(), unlisten: vi.fn(),
  progress: new Map<string, (event: { payload: { requestId: string; data: string } }) => void>(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));
const clients: IosGitClient[] = [];
function client(id = "ios:repository") {
  const result = new IosGitClient(id);
  clients.push(result);
  return result;
}
beforeEach(() => {
  invoke.mockReset();
  listen.mockReset();
  unlisten.mockReset();
  progress.clear();
  listen.mockImplementation(async (event, callback) => {
    progress.set(event, callback);
    return unlisten;
  });
});
afterEach(async () => { for (const git of clients.splice(0)) await git.dispose(); });

describe("IosGitClient", () => {
  it("scopes requests to an opened native workspace", async () => {
    invoke.mockResolvedValue({ repository: false });
    expect(await client().request("git.status")).toEqual({ repository: false });
    expect(invoke).toHaveBeenCalledWith("ios_git_request", {
      id: "ios:repository", requestId: expect.any(String), method: "status", params: {},
    }, undefined);
    await expect(client().request("fs.read")).rejects.toThrow(/accepts Git requests/);
  });
  it("does not invoke Git for a request cancelled before dispatch", async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(client().request("git.clone", {}, { signal: abort.signal })).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });
  it("allows a failed progress subscription to be retried", async () => {
    listen.mockRejectedValueOnce(new Error("Cannot listen"));
    const git = client();
    await expect(git.request("git.status")).rejects.toThrow("Cannot listen");
    expect(invoke).not.toHaveBeenCalled();
    invoke.mockResolvedValue({ repository: false });
    expect(await git.request("git.status")).toEqual({ repository: false });
    expect(listen).toHaveBeenCalledTimes(2);
  });
  it("waits for native cancellation to finish before completing a mutation", async () => {
    let finish!: (value: unknown) => void;
    invoke.mockImplementation(command => command === "ios_git_request" ? new Promise(resolve => { finish = resolve; }) : Promise.resolve());
    const abort = new AbortController();
    const operation = client().request("git.clone", { destination: "project" }, { signal: abort.signal });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    let completed = false;
    void operation.then(() => { completed = true; });
    const args = invoke.mock.calls[0]![1];
    abort.abort();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("ios_git_cancel", { id: "ios:repository", requestId: args.requestId }, undefined));
    expect(completed).toBe(false);
    finish({ path: "project" });
    await operation;
    expect(completed).toBe(true);
  });
  it("receives progress for its active requests and ignores unrelated operations", async () => {
    let finish!: (value: unknown) => void;
    invoke.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const git = client();
    const received = vi.fn();
    const unsubscribe = git.subscribe("git.progress", received);
    const operation = git.request("git.fetch");
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    const requestId = invoke.mock.calls[0]![1].requestId;
    const send = progress.get("ios-git-progress:ios:repository")!;
    send({ payload: { requestId: "another-client", data: "other" } });
    send({ payload: { requestId, data: "Receiving objects" } });
    expect(received).toHaveBeenCalledExactlyOnceWith({ data: "Receiving objects" });
    unsubscribe();
    send({ payload: { requestId, data: "Complete" } });
    expect(received).toHaveBeenCalledTimes(1);
    finish({ ok: true });
    await operation;
  });
  it("cancels active operations before disposing the progress listener", async () => {
    let finish!: (value: unknown) => void;
    invoke.mockImplementation(command => command === "ios_git_request" ? new Promise(resolve => { finish = resolve; }) : Promise.resolve());
    const git = client();
    const operation = git.request("git.push");
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    const closing = git.dispose();
    expect(git.connected).toBe(false);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("ios_git_cancel", expect.objectContaining({ id: "ios:repository" }), undefined));
    expect(unlisten).not.toHaveBeenCalled();
    finish({ ok: true });
    await operation;
    await closing;
    expect(unlisten).toHaveBeenCalledTimes(1);
    await expect(git.request("git.status")).rejects.toThrow(/closed/);
  });
});

describe("Git account bridge", () => {
  it("requests account metadata and sends new credentials to the native plugin", async () => {
    invoke.mockResolvedValue({ authenticated: true, login: "octocat", name: "Octocat", email: "octocat@example.test" });
    await native.gitCredentials({ operation: "save", name: "Octocat", email: "octocat@example.test", token: "test-token" });
    expect(invoke).toHaveBeenCalledWith("plugin:oxbit-files|git_credentials", { request: {
      operation: "save", name: "Octocat", email: "octocat@example.test", token: "test-token",
    } }, undefined);
  });

  it("sends a Gitea server and token to the native plugin", async () => {
    invoke.mockResolvedValue({ authenticated: false, gitea: { authenticated: true, url: "https://git.example.test", host: "git.example.test", login: "gitea-user" } });
    const account = await native.gitCredentials({ operation: "connectGitea", url: "https://git.example.test", token: "test-token" });
    expect(invoke).toHaveBeenCalledWith("plugin:oxbit-files|git_credentials", { request: {
      operation: "connectGitea", url: "https://git.example.test", token: "test-token",
    } }, undefined);
    expect(account.gitea?.login).toBe("gitea-user");
  });
});
