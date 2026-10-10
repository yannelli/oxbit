import { useState } from "react";
import { ACP_CUSTOM_PROVIDER, ACP_PROVIDERS, acpPreset } from "@oxbit/sdk";
import { Icon, translate as tr } from "@oxbit/ui";
import type { AgentController } from "./controller.js";
import { settingId } from "./configuration.js";
import { formatArgs, parseArgs, storedArgs } from "./launch.js";

const HINTS: Record<string, string> = {
  codex: "Runs with npx. Uses your Codex sign-in.",
  claude: "Runs with npx. Uses your Claude Code sign-in.",
  gemini: "Runs with npx. Sign in or set GEMINI_API_KEY.",
  copilot: "Runs with npx. Sign in with GitHub.",
  cursor: "Needs Cursor CLI and agent login.",
  amp: "Needs Amp CLI and amp login.",
};
export type Chooser = "registry" | "custom";

/** Built-in agents, the current registry or custom choice, and entries for more agents. */
export function AgentPicker({
  agent,
  enabled,
  onChoose,
}: {
  agent: AgentController;
  enabled: boolean;
  onChoose(chooser: Chooser): void;
}) {
  const current = agent.chosen.provider;
  const select = (provider: string) =>
    void agent.action(() => agent.select({ provider }));
  const row = (id: string, name: string, hint: string, title = hint) => (
    <button
      key={id}
      type="button"
      role="radio"
      aria-checked={current === id}
      className="acp-agent-option"
      disabled={agent.connecting}
      onClick={() => select(id)}
    >
      <Icon name={current === id ? "check" : "agent"} size={14} />
      <span>
        <strong>{name}</strong>
        <small title={title}>{hint}</small>
      </span>
    </button>
  );
  const extra = !acpPreset(current);
  return (
    <section className="acp-agent-picker" aria-label={tr("Choose an agent")}>
      <h2>{tr("Choose an agent")}</h2>
      <div role="radiogroup" aria-label={tr("Agent")}>
        {ACP_PROVIDERS.map((preset) =>
          row(preset.id, preset.name, tr(HINTS[preset.id] ?? preset.setup), tr(preset.setup)),
        )}
        {extra &&
          row(
            current,
            agent.displayName,
            tr(current === ACP_CUSTOM_PROVIDER ? "Custom agent" : "ACP Registry agent"),
          )}
      </div>
      <div className="acp-agent-more">
        <button type="button" className="acp-agent-option" onClick={() => onChoose("registry")}>
          <Icon name="package" size={14} />
          <span><strong>{tr("More agents…")}</strong><small>{tr("Browse the ACP Registry")}</small></span>
        </button>
        <button type="button" className="acp-agent-option" onClick={() => onChoose("custom")}>
          <Icon name="pencil" size={14} />
          <span><strong>{tr("Custom agent…")}</strong><small>{tr("Run any ACP executable")}</small></span>
        </button>
      </div>
      <button
        type="button"
        className="button primary acp-agent-start"
        disabled={!enabled || agent.connecting}
        onClick={() => void agent.action(() => agent.connectSelected())}
      >
        {tr("Start {0}", { 0: agent.displayName })}
      </button>
    </section>
  );
}

/** Space-separated arguments stored as the JSON array setting. */
export function ArgumentsField({
  value,
  disabled,
  onChange,
}: {
  value: string;
  disabled?: boolean;
  onChange(value: string): void;
}) {
  return (
    <label>
      {tr("Arguments")}
      <input
        aria-label={tr("Agent arguments")}
        value={value}
        disabled={disabled}
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
      />
      <small className="muted">{tr("Separate arguments with spaces. Quote an argument that contains spaces.")}</small>
    </label>
  );
}

export function CustomAgentForm({
  agent,
  onDone,
  embedded = false,
}: {
  agent: AgentController;
  onDone(): void;
  embedded?: boolean;
}) {
  const config = agent.options.kernel.configuration;
  const [name, setName] = useState(config.get<string>(settingId(ACP_CUSTOM_PROVIDER, "name")) ?? "");
  const [command, setCommand] = useState(config.get<string>(settingId(ACP_CUSTOM_PROVIDER, "command")) ?? "");
  const [args, setArgs] = useState(
    formatArgs(storedArgs(config.get<string>(settingId(ACP_CUSTOM_PROVIDER, "args"))) ?? []),
  );
  return (
    <form
      className={embedded ? "acp-custom-agent" : "acp-setup acp-custom-agent"}
      aria-label={tr("Custom agent")}
      onSubmit={(event) => {
        event.preventDefault();
        void agent.action(async () => {
          if (!command.trim()) throw new Error(tr("Enter the agent executable"));
          await agent.select({
            provider: ACP_CUSTOM_PROVIDER,
            name: name.trim() || tr("Custom agent"),
            command: command.trim(),
            args: parseArgs(args),
          });
          onDone();
        });
      }}
    >
      {!embedded && <h2>{tr("Custom agent")}</h2>}
      <label>
        {tr("Name")}
        <input aria-label={tr("Agent name")} value={name} placeholder={tr("Custom agent")} onChange={(event) => setName(event.target.value)} />
      </label>
      <label>
        {tr("Executable")}
        <input aria-label={tr("Agent executable")} value={command} spellCheck={false} onChange={(event) => setCommand(event.target.value)} />
      </label>
      <ArgumentsField value={args} onChange={setArgs} />
      <div className="acp-actions">
        <button type="submit" className="button primary">{tr(embedded ? "Save" : "Use custom agent")}</button>
        {!embedded && <button type="button" className="button" onClick={onDone}>{tr("Cancel")}</button>}
      </div>
    </form>
  );
}
