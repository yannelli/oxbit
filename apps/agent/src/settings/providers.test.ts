import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { FileAuthStore } from "../auth.js";
import { selectProvider } from "../providers.js";
import { panelContext, testSetup } from "../testing.js";
import { createSettingsManager } from "./index.js";

describe("providers panel", () => {
  it("shows each provider's status, saves and removes keys, and rebuilds for the provider in use", async () => {
    const t = await testSetup([]);
    const auth = new FileAuthStore(t.config.paths.auth);
    const env = { OPENROUTER_API_KEY: "or-env" };
    let current = await selectProvider({ settings: t.config.settings, env, auth, fetch: vi.fn(), provider: "ollama" });
    const rebuild = vi.fn(async (id: string) => {
      current = await selectProvider({ settings: t.config.settings, env, auth, fetch: vi.fn(), provider: id });
    });
    const manager = createSettingsManager({ config: t.config, auth, env, home: t.home, fetch: vi.fn(), provider: () => current, rebuild });
    const context = panelContext(t.root);
    const rows = async () => Object.fromEntries((await manager.panel("providers", context)).rows
      .map((row) => [row.id, { detail: row.detail, enabled: row.enabled, actions: row.actions?.map((action) => `${action.id}${action.reloads ? "!" : ""}`) }]));
    expect(await rows()).toEqual({
      openai: { detail: "no key", enabled: true, actions: ["use!", "key", "chatgpt"] },
      anthropic: { detail: "no key, Claude Console API key", enabled: true, actions: ["use!", "key"] },
      openrouter: { detail: "key from OPENROUTER_API_KEY", enabled: true, actions: ["use!", "key"] },
      ollama: { detail: "in use, no key needed, http://127.0.0.1:11434", enabled: true, actions: [] },
      "openai-compatible": { detail: "no base URL", enabled: true, actions: ["use!", "key", "base-url"] },
      claude: { detail: "Claude Code not installed, Claude Agent with Claude Code's own sign-in", actions: ["use!"] },
    });

    expect(await manager.act("providers", "anthropic", "key", ["sk-ant "], context)).toEqual({ message: `Saved the Anthropic API key in ${auth.path}` });
    expect(rebuild).not.toHaveBeenCalled();
    await t.config.saveSettings({ model: "llama3" });
    expect(await manager.act("providers", "anthropic", "use", [], context)).toEqual({ message: "Using Anthropic", reloaded: true });
    expect(rebuild).toHaveBeenLastCalledWith("anthropic");
    expect(JSON.parse(await readFile(t.config.paths.settings, "utf8"))).toEqual({ provider: "anthropic", providers: { ollama: { model: "llama3" } } });
    expect((await rows()).anthropic).toEqual({ detail: "in use, API key saved, Claude Console API key", enabled: true, actions: ["key!", "remove-key!"] });

    expect(await manager.act("providers", "anthropic", "remove-key", [], context)).toEqual({ message: "Removed the Anthropic API key", reloaded: true });
    expect(rebuild).toHaveBeenCalledTimes(2);
    expect(JSON.parse(await readFile(auth.path, "utf8"))).toEqual({});
    await manager.toggle("providers", "openrouter", false, context);
    expect((await rows()).openrouter).toMatchObject({ detail: "key from OPENROUTER_API_KEY, disabled", enabled: false });
    expect(await manager.act("providers", "openai", "signout", [], context)).toEqual({ message: "Not signed in with ChatGPT" });

    await expect(manager.act("providers", "openai-compatible", "use", [], context)).rejects.toThrow("baseUrl");
    expect(await manager.act("providers", "openai-compatible", "base-url", ["https://llm.example.com/v1/"], context)).toEqual({ message: "Base URL: https://llm.example.com" });
    expect((await rows())["openai-compatible"].detail).toBe("no key needed, https://llm.example.com");
    const later = createSettingsManager({ config: t.config, auth, env, home: t.home, provider: () => current });
    expect(await later.act("providers", "openai-compatible", "use", [], context)).toEqual({ message: "Using OpenAI-compatible. It applies after the agent restarts." });
    expect(t.config.settings.provider).toBe("openai-compatible");
    expect(await later.act("providers", "claude", "use", [], context)).toEqual({ message: "Using Claude plan. It applies after the agent restarts." });
    expect(t.config.settings.provider).toBe("claude");
  });
});
