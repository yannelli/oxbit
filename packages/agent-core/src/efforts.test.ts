import { describe, expect, it } from "vitest";
import { anthropicMessages } from "./anthropic-messages.js";
import { chatCompletions } from "./chat-completions.js";
import { CHATGPT_MODELS, chatgptResponses } from "./chatgpt.js";
import { effortLabel, listedEfforts, modelEfforts } from "./efforts.js";
import { listModels, type ModelInput } from "./model.js";
import { openaiResponses } from "./openai-responses.js";
import { fakeModels } from "./test-models.js";

const FIVE = ["low", "medium", "high", "xhigh", "max"];
const of = (api: Parameters<typeof modelEfforts>[0], id: string) => modelEfforts(api, { id, name: id });
const input = (effort?: string): ModelInput => ({ model: "m", system: "S", turns: [{ role: "user", text: "Hi" }], tools: [], effort });

describe("reasoning levels per model", () => {
  it("uses the OpenAI family table for openai and chatgpt models the list does not describe", () => {
    expect(of("openai", "gpt-6.1-sol")).toEqual(FIVE);
    expect(of("openai", "gpt-6-astra")).toEqual(FIVE);
    expect(of("openai", "gpt-6-sol")).toEqual(["none", ...FIVE]);
    expect(of("openai", "gpt-5.5-2026-04-23")).toEqual(["none", "low", "medium", "high", "xhigh"]);
    expect(of("openai", "gpt-5.4-mini")).toEqual(["none", "low", "medium", "high", "xhigh"]);
    expect(of("openai", "gpt-5.1")).toEqual(["none", "low", "medium", "high"]);
    expect(of("openai", "gpt-5-mini")).toEqual(["minimal", "low", "medium", "high"]);
    expect(of("chatgpt", "gpt-5.6-terra")).toEqual(FIVE);
    for (const id of ["gpt-4.1", "gpt-4o-mini", "gpt-4", "chatgpt-4o-latest"]) expect(of("openai", id)).toEqual([]);
    expect(of("openai", "o3")).toEqual(["low", "medium", "high"]);
  });
  it("uses the Claude effort table, and no levels for Claude models without effort", () => {
    for (const id of ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5", "claude-opus-4-8"])
      expect(of("anthropic", id)).toEqual(FIVE);
    expect(of("anthropic", "claude-opus-4-6")).toEqual(["low", "medium", "high", "max"]);
    expect(of("anthropic", "claude-opus-4-5-20251101")).toEqual(["low", "medium", "high"]);
    expect(of("anthropic", "claude-haiku-4-5")).toEqual([]);
    expect(of("anthropic", "claude-sonnet-4-5")).toEqual([]);
  });
  it("keeps a conservative list for unknown openai-compatible models and prefers the model list's levels", () => {
    expect(of("openai-compatible", "qwen3:0.6b")).toEqual(["low", "medium", "high"]);
    expect(modelEfforts("openai-compatible", { id: "x", name: "x", efforts: [] })).toEqual([]);
    expect(modelEfforts("openai", { id: "gpt-6-sol", name: "x", efforts: ["low", "max"] })).toEqual(["low", "max"]);
    expect(CHATGPT_MODELS.find((model) => model.id === "gpt-5.5")?.efforts).toEqual(["low", "medium", "high", "xhigh"]);
    expect(CHATGPT_MODELS.every((model) => model.efforts?.length)).toBe(true);
  });
  it("labels levels", () => {
    expect(["none", "minimal", "xhigh", "max", "future"].map(effortLabel)).toEqual(["None", "Minimal", "Extra high", "Max", "Future"]);
  });
});

describe("reasoning levels from model lists", () => {
  it("reads Anthropic capabilities.effort", async () => {
    const supported = (value: boolean) => ({ supported: value });
    const list = { data: [
      { id: "claude-opus-4-6", capabilities: { effort: { supported: true, low: supported(true), medium: supported(true), high: supported(true), xhigh: null, max: supported(true) } } },
      { id: "claude-haiku-4-5", capabilities: { effort: { supported: false, low: supported(false) } } },
      { id: "claude-new" },
    ] };
    const models = await listModels(fakeModels([], { list }).models, { api: "anthropic" });
    expect(models.map((model) => model.efforts)).toEqual([["low", "medium", "high", "max"], [], undefined]);
  });
  it("reads OpenRouter reasoning.supported_efforts lowest first, and no levels for models without reasoning", () => {
    expect(listedEfforts({ reasoning: { supported_efforts: ["xhigh", "high", "medium", "low", "minimal", "none"], mandatory: false } }))
      .toEqual(["none", "minimal", "low", "medium", "high", "xhigh"]);
    expect(listedEfforts({ reasoning: { supported_efforts: null, mandatory: true } })).toEqual(["minimal", "low", "medium", "high", "xhigh", "max"]);
    expect(listedEfforts({ supported_parameters: ["tools", "temperature"] })).toEqual([]);
    expect(listedEfforts({ supported_parameters: ["tools", "reasoning"] })).toBeUndefined();
    expect(listedEfforts({ id: "llama3" })).toBeUndefined();
  });
  it("reads Codex supported_reasoning_levels without ultra", async () => {
    const level = (effort: string) => ({ effort, description: effort });
    const list = { models: [
      { slug: "gpt-a", visibility: "list", priority: 1, supported_reasoning_levels: ["high", "low", "max", "ultra", "medium"].map(level) },
      { slug: "gpt-b", visibility: "list", priority: 2, supported_reasoning_levels: [] },
    ] };
    const models = await listModels(fakeModels([], { list }).models, { api: "chatgpt" });
    expect(models.map((model) => [model.id, model.efforts])).toEqual([["gpt-a", ["low", "medium", "high", "max"]], ["gpt-b", []]]);
  });
});

describe("reasoning request fields", () => {
  const body = (request: { body?: unknown }) => request.body as Record<string, unknown>;
  it("sends reasoning.effort on Responses and ChatGPT", () => {
    for (const adapter of [openaiResponses, chatgptResponses])
      for (const effort of ["none", "xhigh", "max"]) expect(body(adapter.request(input(effort))).reasoning).toEqual({ effort, summary: "auto" });
    expect(body(openaiResponses.request(input()))).not.toHaveProperty("reasoning");
  });
  it("sends reasoning_effort on Chat Completions", () => {
    for (const effort of ["minimal", "high", "max"]) expect(body(chatCompletions.request(input(effort))).reasoning_effort).toBe(effort);
    expect(body(chatCompletions.request(input()))).not.toHaveProperty("reasoning_effort");
  });
  it("sends output_config.effort on Messages", () => {
    for (const effort of ["low", "xhigh", "max"]) expect(body(anthropicMessages.request(input(effort))).output_config).toEqual({ effort });
    expect(body(anthropicMessages.request(input()))).not.toHaveProperty("output_config");
  });
});
