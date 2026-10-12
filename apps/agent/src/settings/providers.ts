import { CHATGPT_LABELS, PROVIDERS, apiKeySlot, providerSpec, type ProviderSpec } from "@oxbit/agent-core";
import { stringList } from "../config.js";
import { SIGN_IN_TIMEOUT_MS, apiKeyChoice, fetchOr, openBrowser, removeApiKeys, saveApiKey, signInChatGPT, signOutChatGPT } from "../login.js";
import { chatgptSignedIn, normalizeBase, selectProvider, type ProviderInput } from "../providers.js";
import type { PanelAction, PanelChange, PanelContext, PanelRow } from "../tui/connection.js";
import { setListed, unknownRow, type PanelHandler, type SettingsDeps } from "./shared.js";

const OLLAMA = "http://127.0.0.1:11434";
const input = (deps: SettingsDeps): ProviderInput => ({ settings: deps.config.settings, env: deps.env, auth: deps.auth, fetch: deps.fetch });
const has = (spec: ProviderSpec, method: string) => spec.methods.some((item) => item.id === method);

function baseOf(spec: ProviderSpec, deps: SettingsDeps) {
  const own = deps.config.settings.providers?.[spec.id]?.baseUrl;
  const base = spec.id === "openai-compatible" ? own || deps.env.OXBIT_AGENT_BASE_URL : spec.id === "ollama" ? own || deps.env.OLLAMA_HOST || OLLAMA : own;
  try {
    return base ? normalizeBase(base) : undefined;
  } catch {
    return undefined;
  }
}

async function status(spec: ProviderSpec, deps: SettingsDeps, signedIn: boolean) {
  const parts: string[] = [];
  const current = deps.provider();
  if (current.id === spec.id) parts.push(current.runtime.method === "chatgpt" ? "in use with your ChatGPT plan" : "in use");
  if (spec.id === "openai" && signedIn) parts.push("signed in with ChatGPT");
  const base = baseOf(spec, deps);
  let saved = false;
  if (spec.id === "openai-compatible" && !base) parts.push("no base URL");
  else if (has(spec, "api-key")) {
    saved = !!await deps.auth.get(apiKeySlot(spec.id, base));
    const env = spec.env && deps.env[spec.env] ? spec.env : undefined;
    parts.push(saved ? "API key saved" : env ? `key from ${env}` : has(spec, "none") ? "no key needed" : "no key");
  } else parts.push("no key needed");
  if (base && spec.id !== "openrouter") parts.push(base);
  if (spec.id === "anthropic") parts.push("Claude Console API key");
  if (stringList(deps.config.settings.disabledProviders).includes(spec.id)) parts.push("disabled");
  return { text: parts.join(", "), saved };
}

/** Rebuilds the agent with `id` when the TUI can, else says when the change applies. */
async function apply(deps: SettingsDeps, id: string, message: string): Promise<PanelChange> {
  if (deps.rebuild) {
    await deps.rebuild(id);
    return { message, reloaded: true };
  }
  return { message: `${message}. It applies after the agent restarts.` };
}

async function use(deps: SettingsDeps, spec: ProviderSpec): Promise<PanelChange> {
  const { config } = deps;
  await selectProvider({ ...input(deps), provider: spec.id });
  const previous = config.settings.provider ?? deps.provider().id;
  const providers = { ...config.settings.providers };
  if (config.settings.model && !providers[previous]?.model) providers[previous] = { ...providers[previous], model: config.settings.model };
  await config.saveSettings({ provider: spec.id, model: undefined, providers });
  return apply(deps, spec.id, `Using ${spec.name}`);
}

async function signIn(deps: SettingsDeps, context: PanelContext) {
  const signal = AbortSignal.any([context.signal, AbortSignal.timeout(SIGN_IN_TIMEOUT_MS)]);
  const { account, enabled } = await signInChatGPT({ config: deps.config, auth: deps.auth, fetch: fetchOr(deps.fetch), signal, open: async (url) => {
    context.progress(`Open this page to sign in: ${url}`);
    if (!await (deps.open ?? ((target: string) => openBrowser(target, deps.env)))(url)) context.progress(`No browser opened. Open this page to sign in: ${url}`);
  } });
  if (!enabled) throw new Error("You are signed in, but ChatGPT plan use was not allowed. Sign in again and allow it, or use an OpenAI API key.");
  return `${CHATGPT_LABELS.welcome}${account.email ? ` (${account.email})` : ""}`;
}

export const providersPanel: PanelHandler = {
  async panel(deps) {
    const signedIn = await chatgptSignedIn(deps.auth);
    const disabled = stringList(deps.config.settings.disabledProviders);
    const rows = await Promise.all(PROVIDERS.map(async (spec): Promise<PanelRow> => {
      const inUse = deps.provider().id === spec.id;
      const { text, saved } = await status(spec, deps, signedIn);
      const reloads = inUse || undefined;
      const actions: PanelAction[] = inUse ? [] : [{ id: "use", label: "Use this provider", reloads: true }];
      if (has(spec, "api-key")) actions.push({ id: "key", label: "Set API key", inputs: [{ label: spec.methods.find((item) => item.id === "api-key")!.label, secret: true }], reloads });
      if (saved) actions.push({ id: "remove-key", label: "Remove API key", reloads });
      if (has(spec, "chatgpt")) actions.push(signedIn ? { id: "signout", label: "Sign out of ChatGPT", reloads } : { id: "chatgpt", label: "Sign in with ChatGPT", reloads });
      if (spec.id === "openai-compatible") actions.push({ id: "base-url", label: "Base URL", reloads,
        inputs: [{ label: "Base URL (empty clears it)", placeholder: "https://llm.example.com", value: deps.config.settings.providers?.[spec.id]?.baseUrl ?? "" }] });
      return { id: spec.id, section: "Providers", label: spec.name, detail: text, enabled: !disabled.includes(spec.id), actions };
    }));
    return { id: "providers", title: "Providers", rows, footer: "Unchecked providers are skipped when settings name no provider; --provider and Use still pick them." };
  },
  async toggle({ config }, rowId, enabled) {
    const spec = providerSpec(rowId);
    if (!spec) throw unknownRow(rowId);
    await setListed(config, "disabledProviders", spec.id, !enabled);
    return { message: `${spec.name} is ${enabled ? "on" : "off"} for automatic selection` };
  },
  async act(deps, rowId, actionId, inputs, context) {
    const spec = providerSpec(rowId);
    if (!spec) throw unknownRow(rowId);
    const inUse = deps.provider().id === spec.id;
    const done = (message: string) => inUse ? apply(deps, spec.id, message) : Promise.resolve({ message });
    switch (actionId) {
      case "use": return use(deps, spec);
      case "key": {
        const key = inputs[0]?.trim();
        if (!key) throw new Error("The API key is empty");
        await saveApiKey(deps.config, await apiKeyChoice(input(deps), spec.id), key);
        return done(`Saved the ${spec.name} API key in ${deps.auth.path}`);
      }
      case "remove-key": {
        const removed = await removeApiKeys(deps.auth, input(deps), spec.id);
        return done(removed.length ? `Removed the ${spec.name} API key` : "No saved key to remove");
      }
      case "chatgpt": {
        if (spec.id !== "openai") break;
        return done(await signIn(deps, context));
      }
      case "signout": {
        const revoked = await signOutChatGPT(deps.auth, fetchOr(deps.fetch));
        if (revoked === undefined) return { message: "Not signed in with ChatGPT" };
        return done(revoked ? "Signed out of ChatGPT" : "Signed out here; OpenAI did not confirm the revocation");
      }
      case "base-url": {
        if (spec.id !== "openai-compatible") break;
        const value = inputs[0]?.trim();
        const baseUrl = value ? normalizeBase(value) : undefined;
        const providers = deps.config.settings.providers ?? {};
        await deps.config.saveSettings({ providers: { ...providers, [spec.id]: { ...providers[spec.id], baseUrl } } });
        return done(baseUrl ? `Base URL: ${baseUrl}` : "Cleared the base URL");
      }
    }
    throw unknownRow(`${rowId} ${actionId}`);
  },
};
