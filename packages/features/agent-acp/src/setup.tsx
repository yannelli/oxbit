import { useState } from "react";
import { ACP_CUSTOM_PROVIDER, acpPreset } from "@oxbit/sdk";
import { translate as tr } from "@oxbit/ui";
import type { AgentController } from "./controller.js";
import { settingId } from "./configuration.js";
import { formatArgs, parseArgs, storedArgs } from "./launch.js";
import { ArgumentsField, CustomAgentForm } from "./agent-picker.js";

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
