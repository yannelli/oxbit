import { afterEach, describe, expect, it, vi } from "vitest";
import { MISSING_AGENT_KEY, type AgentModelRequest } from "@oxbit/sdk";
import { IosAgentModels } from "./agent-models.js";
import type { AgentModelStreamEvent } from "./native.js";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  Channel: class {
    static next = 0;
    id = ++(this.constructor as { next: number }).next;
    constructor(public onmessage: (message: unknown) => void) {}
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

type Channel = { onmessage: (message: AgentModelStreamEvent) => void };
type StreamArgs = { id: string; channel: Channel } & Record<string, unknown>;

const STREAM = "plugin:oxbit-files|agent_models_stream";
const CANCEL = "plugin:oxbit-files|agent_models_cancel";
const KEY = "plugin:oxbit-files|agent_models_key";
const request: AgentModelRequest = { api: "openai", method: "POST", path: "/v1/responses", body: { model: "gpt-5", stream: true } };
const encode = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));
const chunk = (data: string): AgentModelStreamEvent => ({ type: "chunk", data });

/** Records stream starts; `start` rejects the start command when set. */
function device(start?: unknown) {
  const streams: StreamArgs[] = [];
  invoke.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    if (command === STREAM) {
      if (start) throw start;
      streams.push(args as StreamArgs);
      return null;
    }
    if (command === CANCEL) return null;
    if (command === KEY) return args.operation === "has" ? { saved: args.api === "anthropic" } : null;
    throw new Error(`Unexpected native command ${command}`);
  });
  return streams;
}

async function collect(iterable: AsyncIterable<string>) {
  const chunks: string[] = [];
  for await (const text of iterable) chunks.push(text);
  return chunks;
}

const cancels = () => invoke.mock.calls.filter(([command]) => command === CANCEL).map(([, args]) => args);

describe("iOS agent models", () => {
  afterEach(() => invoke.mockReset());

  it("checks, saves and removes keys by endpoint without reading them back", async () => {
    device();
    const models = new IosAgentModels();
    await expect(models.keys.has({ api: "anthropic" })).resolves.toBe(true);
    await expect(models.keys.has({ api: "openai-compatible", baseUrl: "https://openrouter.ai/api" })).resolves.toBe(false);
    await models.keys.save({ api: "openai" }, "sk-test");
    await models.keys.remove({ api: "openai-compatible", baseUrl: "https://openrouter.ai/api" });
    expect(invoke.mock.calls.map(([command, args]) => [command, args])).toEqual([
      [KEY, { operation: "has", api: "anthropic", baseUrl: undefined }],
      [KEY, { operation: "has", api: "openai-compatible", baseUrl: "https://openrouter.ai/api" }],
      [KEY, { operation: "save", api: "openai", baseUrl: undefined, key: "sk-test" }],
      [KEY, { operation: "remove", api: "openai-compatible", baseUrl: "https://openrouter.ai/api" }],
    ]);
  });

  it("starts the native request with a JSON body and yields decoded chunks in order", async () => {
    const streams = device();
    const result = collect(new IosAgentModels().stream({ ...request, api: "openai-compatible", baseUrl: "https://openrouter.ai/api" }));
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    const { id, channel, ...args } = streams[0]!;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(args).toEqual({
      api: "openai-compatible", baseUrl: "https://openrouter.ai/api", method: "POST", path: "/v1/responses",
      body: JSON.stringify(request.body),
    });
    const text = "data: {\"delta\":\"héllo\"}\n\n";
    const split = new TextEncoder().encode(text);
    const at = text.indexOf("é") + 1;
    const part = (from: number, to?: number) => btoa(String.fromCharCode(...split.slice(from, to)));
    channel.onmessage(chunk(part(0, at)));
    channel.onmessage(chunk(part(at)));
    channel.onmessage(chunk(encode("data: [DONE]\n\n")));
    channel.onmessage({ type: "end", status: 200 });
    expect((await result).join("")).toBe(text + "data: [DONE]\n\n");
    expect(cancels()).toEqual([]);
  });

  it("throws an AgentModelError with the status and body for a non-2xx answer", async () => {
    const streams = device();
    const result = collect(new IosAgentModels().stream(request));
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    const body = JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });
    streams[0]!.channel.onmessage({ type: "end", status: 401, body });
    await expect(result).rejects.toMatchObject({ name: "AgentModelError", status: 401, body, message: "The model API answered 401: invalid x-api-key" });
    expect(cancels()).toEqual([]);
  });

  it("throws the native message for a failed request and a missing key", async () => {
    const streams = device();
    const failed = collect(new IosAgentModels().stream(request));
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    streams[0]!.channel.onmessage({ type: "failed", message: "The Internet connection appears to be offline." });
    await expect(failed).rejects.toThrow("The Internet connection appears to be offline.");

    invoke.mockReset();
    device({ code: "MISSING_KEY", message: MISSING_AGENT_KEY });
    await expect(collect(new IosAgentModels().stream(request))).rejects.toMatchObject({ code: "MISSING_KEY", message: MISSING_AGENT_KEY });
    expect(cancels()).toEqual([]);
  });

  it("cancels the native request on abort and rethrows the abort reason", async () => {
    const streams = device();
    const controller = new AbortController();
    const iterator = new IosAgentModels().stream(request, controller.signal)[Symbol.asyncIterator]();
    const first = iterator.next();
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    streams[0]!.channel.onmessage(chunk(encode("data: one\n\n")));
    await expect(first).resolves.toEqual({ done: false, value: "data: one\n\n" });

    const second = iterator.next();
    controller.abort();
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    expect(cancels()).toEqual([{ id: streams[0]!.id }]);
    streams[0]!.channel.onmessage(chunk(encode("data: late\n\n")));
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("cancels once the request starts when the signal aborts during the start", async () => {
    let release!: () => void;
    const controller = new AbortController();
    invoke.mockImplementation((command: string) =>
      command === STREAM ? new Promise<null>((resolve) => (release = () => resolve(null))) : Promise.resolve(null));
    const result = collect(new IosAgentModels().stream(request, controller.signal));
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    controller.abort();
    expect(cancels()).toEqual([]);
    release();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    const id = (invoke.mock.calls.find(([command]) => command === STREAM)![1] as StreamArgs).id;
    expect(cancels()).toEqual([{ id }]);
  });

  it("does not start when the signal is already aborted, and cancels when the consumer stops early", async () => {
    const streams = device();
    await expect(collect(new IosAgentModels().stream(request, AbortSignal.abort()))).rejects.toMatchObject({ name: "AbortError" });
    expect(invoke).not.toHaveBeenCalled();

    const pending = (async () => {
      for await (const text of new IosAgentModels().stream(request)) return text;
    })();
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    streams[0]!.channel.onmessage(chunk(encode("data: first\n\n")));
    await expect(pending).resolves.toBe("data: first\n\n");
    expect(cancels()).toEqual([{ id: streams[0]!.id }]);
  });
});
