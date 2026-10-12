import { useEffect, useRef, useState } from "react";
import {
  ACP_CUSTOM_PROVIDER,
  AGENT_MODELS_SERVICE,
  OXBIT_AGENT_PROVIDER,
  OXBIT_AGENT_SETTINGS,
  acpPreset,
  type AgentModelApi,
  type AgentModelEndpoint,
  type AgentModels,
  type ChatGPTDeviceCode,
  type ChatGPTSignIn,
} from "@oxbit/sdk";
import { Select, translate as tr } from "@oxbit/ui";
import type { AgentController } from "./controller.js";
import { oxbitEndpoint, settingId } from "./configuration.js";
import { formatArgs, parseArgs, storedArgs } from "./launch.js";
import { ArgumentsField, CustomAgentForm } from "./agent-picker.js";
import { SIGN_IN_EXPIRED, waitForSignIn } from "./chatgpt-sign-in.js";

/** Launch settings for the connected or chosen agent. */
export function AgentSetup({ agent }: { agent: AgentController }) {
  const config = agent.options.kernel.configuration;
  const provider = agent.connection?.provider ?? agent.chosen.provider;
  const preset = acpPreset(provider);
  const locked = !!agent.connection || agent.connecting;
  const [command, setCommand] = useState(
    config.get<string>(settingId(provider, "command")) || preset?.command || "",
  );
  const [args, setArgs] = useState(
    formatArgs(storedArgs(config.get<string>(settingId(provider, "args"))) ?? [...(preset?.args ?? [])]),
  );
  const [argsError, setArgsError] = useState("");
  if (provider === OXBIT_AGENT_PROVIDER) return <OxbitSetup agent={agent} />;
  const note = (
    <p className="muted">
      {tr(
        "Connecting may download the adapter. Agents run with the trusted runtime's privileges and use its existing credentials.",
      )}
    </p>
  );
  if (provider === ACP_CUSTOM_PROVIDER && !locked)
    return (
      <div className="acp-setup">
        <CustomAgentForm agent={agent} embedded onDone={() => {}} />
        {note}
      </div>
    );
  if (!preset) {
    const entry = agent.registry?.agents.find((item) => item.id === provider);
    return (
      <div className="acp-setup">
        <p>
          <strong>{agent.displayName}</strong>
          {entry && ` · ${entry.version} · ${entry.distribution}`}
        </p>
        {entry?.description && <p>{entry.description}</p>}
        <p className="muted">
          {tr(
            provider === ACP_CUSTOM_PROVIDER
              ? "Custom agent"
              : "The runtime installs this agent from the ACP Registry and keeps its pinned version.",
          )}
        </p>
        {note}
      </div>
    );
  }
  return (
    <div className="acp-setup">
      <p>
        {tr(preset.setup)}{" "}
        <a href={preset.url} target="_blank" rel="noreferrer">
          {tr("Setup guide")}
        </a>
      </p>
      <label>
        {tr("Executable")}
        <input
          aria-label={tr("Agent executable")}
          value={command}
          disabled={locked}
          spellCheck={false}
          onChange={(event) => {
            setCommand(event.target.value);
            void config.set(settingId(provider, "command"), event.target.value, "user");
          }}
        />
      </label>
      <ArgumentsField
        value={args}
        disabled={locked}
        onChange={(value) => {
          setArgs(value);
          try {
            void config.set(settingId(provider, "args"), JSON.stringify(parseArgs(value)), "user");
            setArgsError("");
          } catch (error) {
            setArgsError(error instanceof Error ? error.message : String(error));
          }
        }}
      />
      {argsError && <p className="error-text" role="alert">{argsError}</p>}
      {note}
    </div>
  );
}

/** API, base URL, and key or ChatGPT sign-in for the Oxbit agent. Save hands the key to the host's keychain and clears the field. */
function OxbitSetup({ agent }: { agent: AgentController }) {
  const config = agent.options.kernel.configuration;
  const models = agent.options.kernel.services.optional<AgentModels>(AGENT_MODELS_SERVICE);
  const locked = !!agent.connection || agent.connecting;
  const [api, setApi] = useState(() => oxbitEndpoint(config).api);
  const [baseUrl, setBaseUrl] = useState(() => config.get<string>(OXBIT_AGENT_SETTINGS.baseUrl) ?? "");
  const [key, setKey] = useState("");
  const [saved, setSaved] = useState<boolean>();
  const [busy, setBusy] = useState(false);
  const endpoint: AgentModelEndpoint = api === "openai-compatible" ? { api, baseUrl: baseUrl.trim() } : { api };
  const missingUrl = api === "openai-compatible" && !baseUrl.trim();
  const endpointId = JSON.stringify(endpoint);
  const check = () => (models && !missingUrl ? models.keys.has(endpoint) : Promise.resolve(false));
  useEffect(() => {
    let current = true;
    setSaved(undefined);
    check().then((value) => current && setSaved(value), () => current && setSaved(false));
    return () => {
      current = false;
    };
  }, [models, endpointId]);
  const run = (change: (models: AgentModels) => Promise<void>) =>
    void agent.action(async () => {
      if (!models) return;
      setBusy(true);
      try {
        await change(models);
        setSaved(await check());
      } finally {
        setBusy(false);
      }
    });
  return (
    <form
      className="acp-setup"
      aria-label={tr("Oxbit Agent setup")}
      onSubmit={(event) => {
        event.preventDefault();
        if (!key.trim() || missingUrl) return;
        run(async (models) => {
          await models.keys.save(endpoint, key.trim());
          setKey("");
        });
      }}
    >
      <p>
        {tr(
          api === "chatgpt"
            ? "Oxbit Agent runs in the app and calls the Codex models in your ChatGPT plan. The sign-in tokens are stored in the system keychain."
            : "Oxbit Agent runs in the app and calls the model API with your key. The key is stored in the system keychain.",
        )}
      </p>
      <div className="acp-setting">
        <span className="acp-setting-label">{tr("API")}</span>
        <Select
          label={tr("API")}
          value={api}
          options={[
            { value: "openai", label: "OpenAI" },
            { value: "anthropic", label: "Anthropic" },
            { value: "openai-compatible", label: tr("OpenAI-compatible") },
            ...(models?.chatgpt || api === "chatgpt" ? [{ value: "chatgpt", label: tr("ChatGPT plan") }] : []),
          ]}
          disabled={locked}
          onChange={(value) => {
            setApi(value as AgentModelApi);
            void config.set(OXBIT_AGENT_SETTINGS.api, value, "user");
          }}
        />
      </div>
      {api === "openai-compatible" && (
        <label>
          {tr("Base URL")}
          <input
            aria-label={tr("Base URL")}
            value={baseUrl}
            disabled={locked}
            spellCheck={false}
            inputMode="url"
            placeholder="https://openrouter.ai/api"
            onChange={(event) => {
              setBaseUrl(event.target.value);
              void config.set(OXBIT_AGENT_SETTINGS.baseUrl, event.target.value.trim(), "user");
            }}
          />
          <small className="muted">{tr("Origin and path prefix of a Chat Completions API.")}</small>
        </label>
      )}
      {api === "chatgpt" ? (
        <ChatGPTAccount
          models={models}
          saved={saved}
          refresh={() => agent.action(async () => setSaved(await check()))}
        />
      ) : (
        <>
          <label>
            {tr("API key")}
            <input
              type="password"
              aria-label={tr("API key")}
              value={key}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setKey(event.target.value)}
            />
            <small className="muted" aria-live="polite">
              {saved === undefined ? "" : tr(saved ? "Key saved" : "No key saved")}
            </small>
          </label>
          <div className="acp-actions">
            <button type="submit" className="button primary" disabled={busy || !key.trim() || missingUrl}>
              {tr("Save")}
            </button>
            <button
              type="button"
              className="button"
              disabled={busy || !saved}
              onClick={() => run((models) => models.keys.remove(endpoint))}
            >
              {tr("Remove")}
            </button>
          </div>
        </>
      )}
    </form>
  );
}

const message = (error: unknown) => {
  const text = error instanceof Error ? error.message : String(error);
  return text === SIGN_IN_EXPIRED ? tr(SIGN_IN_EXPIRED) : text;
};

/** Device code sign-in to the ChatGPT plan. The host keeps the tokens; Sign out removes them. */
function ChatGPTAccount({ models, saved, refresh }: { models?: AgentModels; saved?: boolean; refresh(): Promise<void> }) {
  const signIn: ChatGPTSignIn | undefined = models?.chatgpt;
  const [device, setDevice] = useState<ChatGPTDeviceCode>();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef<AbortController>(undefined);
  useEffect(() => () => pending.current?.abort(), []);
  const start = async () => {
    if (!signIn) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setCopied(false);
    setError("");
    try {
      const code = await signIn.start(controller.signal);
      controller.signal.throwIfAborted();
      setDevice(code);
      await waitForSignIn(signIn, code, controller.signal);
      await refresh();
    } catch (failure) {
      if (!controller.signal.aborted) setError(message(failure));
    } finally {
      if (pending.current === controller) {
        pending.current = undefined;
        setDevice(undefined);
        setBusy(false);
      }
    }
  };
  const cancel = () => {
    pending.current?.abort();
    pending.current = undefined;
    setDevice(undefined);
    setBusy(false);
  };
  const signOut = async () => {
    if (!models) return;
    setBusy(true);
    setError("");
    try {
      await models.keys.remove({ api: "chatgpt" });
      await refresh();
    } catch (failure) {
      setError(message(failure));
    } finally {
      setBusy(false);
    }
  };
  const copy = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch (failure) {
      setError(message(failure));
    }
  };
  return (
    <div className="acp-chatgpt">
      {device ? (
        <>
          <p>{tr("Open the sign-in page and enter this code.")}</p>
          <div className="acp-actions">
            <output className="acp-device-code" aria-label={tr("ChatGPT sign-in code")}>
              {device.userCode}
            </output>
            <button type="button" className="button" onClick={() => void copy(device.userCode)}>
              {tr(copied ? "Copied" : "Copy code")}
            </button>
          </div>
          <div className="acp-actions">
            <a className="button primary" href={device.verificationUrl} target="_blank" rel="noreferrer">
              {tr("Open sign-in page")}
            </a>
            <button type="button" className="button" onClick={cancel}>
              {tr("Cancel")}
            </button>
          </div>
          <p className="muted" role="status">{tr("Waiting for you to sign in")}</p>
        </>
      ) : (
        <>
          <p className="muted" role="status">
            {saved === undefined ? "" : tr(saved ? "Signed in with ChatGPT" : "Not signed in")}
          </p>
          <div className="acp-actions">
            {saved ? (
              <button type="button" className="button" disabled={busy} onClick={() => void signOut()}>
                {tr("Sign out")}
              </button>
            ) : (
              <button type="button" className="button primary" disabled={busy || !signIn} onClick={() => void start()}>
                {tr("Sign in with ChatGPT")}
              </button>
            )}
          </div>
        </>
      )}
      {error && <p className="error-text" role="alert">{error}</p>}
    </div>
  );
}
