import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { AGENT_MODELS_SERVICE, type RpcClient } from "@oxbit/sdk";
import { chatText, fakeModels } from "@oxbit/agent-core/test-models";
import { createKernel } from "../../../core/src/index";
import { AI_SETTINGS, aiConfiguration } from "./configuration.js";
import { editMarks, runInlineEdit } from "./inline-edit.js";
import { AI_UNAVAILABLE, createAiService, type AiService } from "./service.js";

const kernels: ReturnType<typeof createKernel>[] = [];
afterEach(() => { for (const kernel of kernels.splice(0)) kernel.dispose(); });

function kernelWith(settings: Record<string, unknown>) {
  const kernel = createKernel();
  kernels.push(kernel);
  for (const setting of aiConfiguration) kernel.configuration.register(setting);
  for (const id of ["agentACP.oxbit.api", "agentACP.oxbit.baseUrl", "agentACP.oxbit.model"])
    kernel.configuration.register({ id, title: id, type: "string", default: "" });
  for (const [id, value] of Object.entries(settings)) kernel.configuration.set(id, value);
  return kernel;
}
function fakeRuntime(reply: string) {
  const calls: { method: string; params?: Record<string, unknown> }[] = [];
  const runtime: RpcClient = {
    connected: true,
    subscribe: () => () => {},
    async request<T>(method: string, params?: Record<string, unknown>) { calls.push({ method, params }); return { text: reply } as T; },
  };
  return { runtime, calls };
}

describe("createAiService", () => {
  it("uses the host's model service with the AI model setting", async () => {
    const kernel = kernelWith({ "agentACP.oxbit.api": "openai-compatible", "agentACP.oxbit.baseUrl": "https://models.test/api", [AI_SETTINGS.model]: "fast" });
    const { models, requests } = fakeModels([chatText("done")]);
    kernel.services.register(AGENT_MODELS_SERVICE, models);
    await expect(createAiService(kernel).complete({ system: "s", prompt: "p" })).resolves.toBe("done");
    expect(requests[0]).toMatchObject({ api: "openai-compatible", baseUrl: "https://models.test/api", path: "/v1/chat/completions" });
    expect((requests[0].body as any).model).toBe("fast");
  });

  it("sends through the runtime when the host has no key", async () => {
    const kernel = kernelWith({ [AI_SETTINGS.model]: "fast", [AI_SETTINGS.effort]: "low" });
    kernel.services.register(AGENT_MODELS_SERVICE, fakeModels([], { key: false }).models);
    const { runtime, calls } = fakeRuntime("from runtime");
    await expect(createAiService(kernel, runtime).complete({ system: "s", prompt: "p", maxTokens: 9 })).resolves.toBe("from runtime");
    expect(calls).toEqual([{ method: "ai.complete", params: { system: "s", prompt: "p", maxTokens: 9, model: "fast", effort: "low" } }]);
  });

  it("sends to OpenRouter with the host's saved OpenRouter key", async () => {
    const kernel = kernelWith({ [AI_SETTINGS.provider]: "openrouter", [AI_SETTINGS.model]: "vendor/fast" });
    const { models, requests } = fakeModels([chatText("done")]);
    const has = vi.fn(async () => true);
    models.keys.has = has;
    kernel.services.register(AGENT_MODELS_SERVICE, models);
    await expect(createAiService(kernel).complete({ system: "s", prompt: "p" })).resolves.toBe("done");
    expect(has).toHaveBeenCalledWith({ api: "openai-compatible", baseUrl: "https://openrouter.ai/api" });
    expect(requests[0]).toMatchObject({ api: "openai-compatible", baseUrl: "https://openrouter.ai/api", path: "/v1/chat/completions" });
    expect((requests[0].body as any).model).toBe("vendor/fast");
  });

  it("asks for a key before sending to OpenRouter without one", async () => {
    const kernel = kernelWith({ [AI_SETTINGS.provider]: "openrouter", [AI_SETTINGS.model]: "vendor/fast" });
    kernel.services.register(AGENT_MODELS_SERVICE, fakeModels([], { key: false }).models);
    await expect(createAiService(kernel).complete({ system: "s", prompt: "p" })).rejects.toThrow("Run Set AI Provider API Key to add a key for OpenRouter");
  });

  it("sends to a local server without a key and needs a model", async () => {
    const kernel = kernelWith({ [AI_SETTINGS.provider]: "local", [AI_SETTINGS.baseUrl]: "http://192.168.1.20:11434" });
    const { models, requests } = fakeModels([chatText("local")], { key: false });
    kernel.services.register(AGENT_MODELS_SERVICE, models);
    await expect(createAiService(kernel).complete({ system: "s", prompt: "p" })).rejects.toThrow("Set AI model to a model on the local model server");
    kernel.configuration.set(AI_SETTINGS.model, "qwen2.5-coder:7b");
    await expect(createAiService(kernel).complete({ system: "s", prompt: "p" })).resolves.toBe("local");
    expect(requests[0]).toMatchObject({ baseUrl: "http://192.168.1.20:11434", path: "/v1/chat/completions" });
  });

  it("names the provider and base URL to the runtime", async () => {
    const kernel = kernelWith({ [AI_SETTINGS.provider]: "local", [AI_SETTINGS.model]: "qwen2.5-coder:7b" });
    const { runtime, calls } = fakeRuntime("from runtime");
    await expect(createAiService(kernel, runtime).complete({ system: "s", prompt: "p" })).resolves.toBe("from runtime");
    expect(calls[0].params).toEqual({ system: "s", prompt: "p", model: "qwen2.5-coder:7b", provider: "ollama", baseUrl: "http://localhost:11434" });
    kernel.configuration.set(AI_SETTINGS.provider, "openai-compatible");
    await expect(createAiService(kernel, runtime).complete({ system: "s", prompt: "p" })).rejects.toThrow("Set AI base URL");
    kernel.configuration.set(AI_SETTINGS.baseUrl, "https://api.example.com");
    await createAiService(kernel, runtime).complete({ system: "s", prompt: "p" });
    expect(calls[1].params).toMatchObject({ provider: "openai-compatible", baseUrl: "https://api.example.com" });
  });

  it("explains what is missing without a runtime or a host service", async () => {
    await expect(createAiService(kernelWith({})).complete({ system: "s", prompt: "p" })).rejects.toThrow(AI_UNAVAILABLE);
  });
});

function fakeView(doc: string, anchor: number, head: number) {
  const view = {
    dom: { isConnected: true },
    state: EditorState.create({ doc, selection: { anchor, head }, extensions: [editMarks] }),
    dispatch(spec: TransactionSpec) { view.state = view.state.update(spec).state; },
  };
  return view as unknown as EditorView;
}
const replying = (reply: string, before?: () => void): AiService => ({
  async complete() { before?.(); return reply; },
});

describe("runInlineEdit", () => {
  it("replaces the selection in one change and marks the new text", async () => {
    const view = fakeView("let a = 1;\nconsole.log(a)\n", 11, 26);
    const applied = await runInlineEdit({ view, service: replying("```js\nconsole.info(`a=${a}`)\n```"), instruction: "use info", path: "a.js" });
    expect(applied).toBe(true);
    expect(view.state.doc.toString()).toBe("let a = 1;\nconsole.info(`a=${a}`)\n");
    expect(view.state.field(editMarks).applied).toEqual({ from: 11, to: 34 });
    view.dispatch({ changes: { from: 0, insert: "// " } });
    expect(view.state.field(editMarks)).toEqual({});
  });

  it("applies nothing when the selected text changes during the request", async () => {
    const view = fakeView("abc", 0, 3);
    const service = replying("xyz", () => view.dispatch({ changes: { from: 1, insert: "!" } }));
    await expect(runInlineEdit({ view, service, instruction: "rename", path: "a.txt" })).rejects.toThrow("selection changed");
    expect(view.state.doc.toString()).toBe("a!bc");
    expect(view.state.field(editMarks)).toEqual({});
  });
});
