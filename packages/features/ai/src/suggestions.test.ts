import { afterEach, describe, expect, it } from "vitest";
import { AGENT_MODELS_SERVICE, type RpcClient } from "@oxbit/sdk";
import { fakeModels } from "@oxbit/agent-core/test-models";
import { createKernel } from "../../../core/src/index";
import { AI_SETTINGS, aiConfiguration } from "./configuration.js";
import { INLINE_MODELS } from "./models.js";
import { modelSuggestions } from "./suggestions.js";

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

describe("modelSuggestions", () => {
  it("lists recommended models for the agent's API and changes key with the provider", async () => {
    const kernel = kernelWith({ "agentACP.oxbit.api": "anthropic" });
    const suggestions = modelSuggestions(kernel);
    const before = suggestions.key();
    expect((await suggestions.list()).map((item) => item.value)).toEqual(INLINE_MODELS.anthropic.map((model) => model.id));
    kernel.configuration.set(AI_SETTINGS.provider, "openrouter");
    expect(suggestions.key()).not.toBe(before);
    expect((await suggestions.list()).map((item) => item.value)).toEqual(INLINE_MODELS.openrouter.map((model) => model.id));
  });

  it("marks recommended local models the server has and adds the other installed ones", async () => {
    const kernel = kernelWith({ [AI_SETTINGS.provider]: "local", [AI_SETTINGS.baseUrl]: "http://192.168.1.20:11434" });
    const recommended = INLINE_MODELS.local[0];
    const { models, requests } = fakeModels([], { key: false, list: { data: [{ id: recommended.id }, { id: "mine:latest" }] } });
    kernel.services.register(AGENT_MODELS_SERVICE, models);
    const list = await modelSuggestions(kernel).list();
    expect(requests[0]).toMatchObject({ method: "GET", baseUrl: "http://192.168.1.20:11434", path: "/v1/models" });
    expect(list[0]).toMatchObject({ value: recommended.id, detail: expect.stringMatching(/^installed/) });
    expect(list.at(-1)).toEqual({ value: "mine:latest", label: "mine:latest", detail: "installed" });
  });

  it("lists a custom server's models through the runtime and keeps recommendations when listing fails", async () => {
    const kernel = kernelWith({ [AI_SETTINGS.provider]: "openai-compatible", [AI_SETTINGS.baseUrl]: "https://api.example.com" });
    const calls: unknown[] = [];
    const runtime: RpcClient = {
      connected: true, subscribe: () => () => {},
      async request<T>(method: string, params?: Record<string, unknown>) { calls.push({ method, params }); return { models: ["served-a"] } as T; },
    };
    expect(await modelSuggestions(kernel, runtime).list()).toEqual([{ value: "served-a", label: "served-a" }]);
    expect(calls).toEqual([{ method: "ai.models", params: { provider: "openai-compatible", baseUrl: "https://api.example.com" } }]);
    kernel.configuration.set(AI_SETTINGS.provider, "local");
    runtime.request = async () => { throw new Error("connection refused"); };
    expect((await modelSuggestions(kernel, runtime).list()).map((item) => item.value)).toEqual(INLINE_MODELS.local.map((model) => model.id));
  });
});
