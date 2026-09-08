import React, { useEffect, useState } from "react";
import type { FeatureOptions, ProjectInfo, ProjectIntelligence, ProjectRelations } from "@oxbit/sdk";

export function ProjectIntelligenceView({ options: o, path }: { options: FeatureOptions; path?: string }) {
  const [info, setInfo] = useState<ProjectInfo>();
  const [index, setIndex] = useState<ProjectIntelligence | null>(null);
  const [relations, setRelations] = useState<ProjectRelations>();
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!o.runtime) return;
    const abort = new AbortController();
    setBusy(true);
    void (async () => {
      if (refresh) await o.runtime!.request("project.refresh", {}, { signal: abort.signal });
      const [index, relations] = await Promise.all([
        o.runtime!.request<ProjectIntelligence | null>("project.intelligence", { limit: 1 }, { signal: abort.signal }),
        path ? o.runtime!.request<ProjectRelations>("project.relations", { path }, { signal: abort.signal }) : undefined,
      ]);
      const info = await o.runtime!.request<ProjectInfo>("project.info", {}, { signal: abort.signal });
      if (!abort.signal.aborted) { setInfo(info); setIndex(index); setRelations(relations); setError(info.error ?? ""); }
    })().catch(error => { if (!abort.signal.aborted) setError(String(error)); }).finally(() => { if (!abort.signal.aborted) setBusy(false); });
    return () => abort.abort();
  }, [o, path, refresh]);
  const open = (file: string) => { void Promise.resolve().then(() => o.workbench.openFile(file)).catch(error => setError(String(error))); };
  return <div style={{ padding: 16, overflow: "auto", height: "100%", boxSizing: "border-box" }}>
    <h2>{info?.configuration.name ?? "Project Intelligence"}</h2>
    <button disabled={busy || !o.runtime} onClick={() => setRefresh(value => value + 1)}>{busy ? "Analyzing…" : "Refresh analysis"}</button>
    <p role="status">{error || (info ? `${info.fileCount} files · ${info.packageCount} packages · ${info.state}` : "Loading project…")}</p>
    {info && <><p>Project settings: <code style={{ overflowWrap: "anywhere" }}>{info.directory}/project.json</code></p>{info.configuration.notes && <p>{info.configuration.notes}</p>}</>}
    {!!index?.frameworks.length && <p>Frameworks: {index.frameworks.join(", ")}</p>}
    {!!index?.warnings.length && <details><summary>Analysis coverage</summary><ul>{index.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul></details>}
    {relations && <section aria-label="Related files">
      <h3>{relations.path}</h3>
      <p>{relations.imports.length} imports · {relations.importedBy.length} direct dependents · {relations.affected.length} files reachable through reverse imports</p>
      {relations.related.length ? <ul>{relations.related.map((item, i) => <li key={i}><button onClick={() => open(item.path)}>{item.path}</button> · {item.reason}</li>)}</ul> : <p>No related files found by static import and test-name analysis.</p>}
    </section>}
    <section aria-label="Project dependencies"><h3>Dependencies</h3>{index?.packages.map(pkg => <details key={pkg.path}><summary>{pkg.name} · {pkg.ecosystem} · {pkg.dependencies.length} dependencies</summary><button onClick={() => open(pkg.path)}>{pkg.path}</button><ul>{pkg.dependencies.map((dependency, i) => <li key={i}>{dependency.name} {dependency.version} · {dependency.kind}</li>)}</ul></details>)}</section>
  </div>;
}
