import { useEffect, useState } from "react";
import { acpPreset, type ACPRegistryAgent } from "@oxbit/sdk";
import { Icon, translate as tr } from "@oxbit/ui";
import { AgentLogo } from "./agent-logo.js";
import type { AgentController } from "./controller.js";

/** Lists agents from the runtime's copy of the ACP Registry. */
export function RegistryBrowser({
  agent,
  onDone,
}: {
  agent: AgentController;
  onDone(): void;
}) {
  const [search, setSearch] = useState("");
  const [failed, setFailed] = useState(false);
  const load = () => {
    setFailed(false);
    void agent.action(() => agent.loadRegistry()).then(() => setFailed(!agent.registry));
  };
  useEffect(() => {
    if (!agent.registry) load();
  }, []);
  const query = search.trim().toLowerCase();
  // Available agents first; Array.prototype.sort is stable, so the registry order holds otherwise.
  const agents = (agent.registry?.agents ?? [])
    .filter(
      (entry) =>
        !query ||
        `${entry.name} ${entry.id} ${entry.description}`.toLowerCase().includes(query),
    )
    .sort((a, b) => Number(!a.available) - Number(!b.available));
  const choose = (entry: ACPRegistryAgent) => {
    if (!entry.available || agent.connecting) return;
    void agent.action(async () => {
      await agent.select(
        entry.builtin
          ? { provider: entry.builtin }
          : { provider: entry.id, registry: { id: entry.id } },
      );
      onDone();
    });
  };
  return (
    <section className="acp-registry" aria-label={tr("ACP Registry")}>
      <div className="acp-registry-heading">
        <h2>{tr("ACP Registry")}</h2>
        <button type="button" className="button" onClick={onDone}>{tr("Done")}</button>
      </div>
      <label className="search-input">
        <Icon name="search" size={14} />
        <input
          aria-label={tr("Search agents")}
          placeholder={tr("Search agents")}
          value={search}
          autoFocus
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Escape" || !search) return;
            event.preventDefault();
            event.stopPropagation();
            setSearch("");
          }}
        />
      </label>
      {(agent.registry?.error || (failed && !agent.registry && !agent.registryLoading)) && (
        <div className="acp-registry-retry">
          <p className="muted">
            {agent.registry
              ? tr("Showing a cached list. The registry could not be reached.")
              : tr("The registry could not be loaded.")}
          </p>
          <button type="button" className="button" disabled={agent.registryLoading} onClick={load}>
            {tr("Retry")}
          </button>
        </div>
      )}
      {agent.registryLoading && !agent.registry && <p className="muted" role="status">{tr("Loading agents…")}</p>}
      {agent.registry && !agents.length && <p className="muted">{tr("No agents match your search")}</p>}
      <div className="acp-registry-list">
        {agents.map((entry) => {
          const builtin = entry.builtin ? acpPreset(entry.builtin) : undefined;
          return (
            <button
              key={entry.id}
              type="button"
              className="acp-registry-entry"
              aria-pressed={agent.chosen.provider === (entry.builtin ?? entry.id)}
              aria-disabled={!entry.available || agent.connecting}
              onClick={() => choose(entry)}
            >
              <span className="acp-registry-title">
                <AgentLogo provider={entry.builtin ?? entry.id} size={14} />
                <strong>{entry.name}</strong>
                <small>{entry.version}</small>
                <small className="acp-registry-tag">{entry.distribution}</small>
                {builtin && <small className="acp-registry-tag">{tr("Built-in")}</small>}
                {!entry.available && <small className="acp-registry-tag">{tr("Unavailable")}</small>}
              </span>
              <small className="acp-registry-description">{entry.description}</small>
              {!entry.available && <small className="acp-registry-reason">{tr(entry.reason ?? "Not available for the runtime's platform")}</small>}
            </button>
          );
        })}
      </div>
    </section>
  );
}
