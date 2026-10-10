import { useEffect, useState } from "react";
import { acpPreset, type ACPRegistryAgent } from "@oxbit/sdk";
import { Icon, translate as tr } from "@oxbit/ui";
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
  useEffect(() => {
    if (!agent.registry) void agent.action(() => agent.loadRegistry());
  }, []);
  const query = search.trim().toLowerCase();
  const agents = (agent.registry?.agents ?? []).filter(
    (entry) =>
      !query ||
      `${entry.name} ${entry.id} ${entry.description}`.toLowerCase().includes(query),
  );
  const choose = (entry: ACPRegistryAgent) =>
    void agent.action(async () => {
      await agent.select(
        entry.builtin
          ? { provider: entry.builtin }
          : { provider: entry.id, registry: { id: entry.id } },
      );
      onDone();
    });
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
        />
      </label>
      {agent.registry?.error && (
        <p className="muted">{tr("Showing a cached list. The registry could not be reached.")}</p>
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
              disabled={!entry.available || agent.connecting}
              title={entry.available ? undefined : tr("Not available for the runtime's platform")}
              onClick={() => choose(entry)}
            >
              <span className="acp-registry-title">
                <strong>{entry.name}</strong>
                <small>{entry.version}</small>
                <small className="acp-registry-tag">{entry.distribution}</small>
                {builtin && <small className="acp-registry-tag">{tr("Built-in")}</small>}
                {!entry.available && <small className="acp-registry-tag">{tr("Unavailable")}</small>}
              </span>
              <small className="acp-registry-description">{entry.description}</small>
            </button>
          );
        })}
      </div>
    </section>
  );
}
