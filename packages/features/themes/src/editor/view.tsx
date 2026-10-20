import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Kernel } from "@oxbit/sdk";
import { themeId, type ResolvedTheme, type ThemePackStore } from "@oxbit/themes";
import { Select, translate as tr } from "@oxbit/ui";
import { currentTheme as selectedTheme, type WorkbenchController } from "@oxbit/workbench";
import { bundledPacks } from "../bundled.js";
import { download } from "../manager.js";
import {
  addVariant,
  check,
  copyTheme,
  currentTheme,
  editInstalled,
  newDraft,
  removeTheme,
  slug,
  uniqueId,
  type Draft,
} from "./draft.js";
import { ColorsPanel, EffectsPanel, GeneralPanel, JsonPanel, SyntaxPanel, TypographyPanel } from "./panels.js";
import { ThemePreview } from "./preview.js";

/** `current` edits the selected theme; installed packs are edited in place and others are copied. */
export type EditorStart = "current" | "new" | { packId: string; themeId: string };

const TABS = ["general", "colors", "syntax", "typography", "effects", "json"] as const;
type Tab = (typeof TABS)[number];
const TAB_LABELS: Record<Tab, string> = {
  general: "General",
  colors: "Colors",
  syntax: "Syntax",
  typography: "Typography",
  effects: "Effects",
  json: "JSON",
};
const HISTORY = 200;

function takenIds(store: ThemePackStore) {
  return [...bundledPacks.map((pack) => pack.id), ...store.list(false).map((entry) => entry.pack.id)];
}

/** Builds a draft from a pack and theme ID: installed packs in place, bundled packs as copies. */
function draftFor(store: ThemePackStore, packId: string, localId: string): Draft | undefined {
  const entry = store.list().find((item) => item.pack.id === packId);
  if (entry?.pack.themes.some((theme) => theme.id === localId)) return editInstalled(entry.pack, localId, entry.assets);
  const bundled = bundledPacks.find((pack) => pack.id === packId);
  if (bundled?.themes.some((theme) => theme.id === localId)) return copyTheme(bundled, localId, takenIds(store));
}

function initialDraft(kernel: Kernel, store: ThemePackStore, start: EditorStart): Draft {
  const selected = selectedTheme(kernel);
  if (typeof start === "object") return draftFor(store, start.packId, start.themeId) ?? newDraft(selected.mode, takenIds(store));
  if (start === "current") return draftFor(store, selected.packId, selected.localId) ?? newDraft(selected.mode, takenIds(store));
  return newDraft(selected.mode, takenIds(store));
}

function themeSources(kernel: Kernel) {
  return kernel.contributions
    .list("theme")
    .map((theme) => (theme.data as { resolved?: ResolvedTheme; packName?: string } | undefined))
    .filter((data): data is { resolved: ResolvedTheme; packName?: string } => !!data?.resolved)
    .map(({ resolved, packName }) => ({
      value: resolved.id,
      label: `${resolved.name}${packName ? ` · ${packName}` : ""}`,
      packId: resolved.packId,
      localId: resolved.localId,
    }));
}

export function ThemeEditor({ kernel, workbench, store, start, request }: {
  kernel: Kernel;
  workbench: WorkbenchController;
  store: ThemePackStore;
  start: EditorStart;
  request: number;
}) {
  useSyncExternalStore(store.subscribe, store.snapshot);
  const [history, setHistory] = useState(() => ({ past: [] as Draft[], present: initialDraft(kernel, store, start), future: [] as Draft[] }));
  const [saved, setSaved] = useState(() => (history.present.installed ? JSON.stringify(history.present.pack) : ""));
  const [tab, setTab] = useState<Tab>("colors");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const previous = useRef(kernel.configuration.get<string>("workbench.colorTheme"));
  const lastValid = useRef<ResolvedTheme>(selectedTheme(kernel));
  const draft = history.present;
  const result = useMemo(() => check(draft), [draft]);
  if (result.resolved) lastValid.current = result.resolved;
  const dirty = JSON.stringify(draft.pack) !== saved;

  const edit = (next: Draft) => setHistory(({ past, present }) => ({ past: [...past, present].slice(-HISTORY), present: next, future: [] }));
  const replace = (next: Draft) => {
    edit(next);
    setSaved(next.installed ? JSON.stringify(next.pack) : "");
  };
  const firstRequest = useRef(request);
  useEffect(() => {
    if (request === firstRequest.current) return;
    firstRequest.current = request;
    replace(initialDraft(kernel, store, start));
    setStatus(tr("Opened a new draft. Undo restores the previous one."));
  }, [request]);

  const perform = async (action: () => Promise<string>) => {
    setBusy(true);
    try {
      setStatus(await action());
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const save = async (asNew = false) => {
    const taken = takenIds(store);
    if (!asNew && !draft.installed && taken.includes(draft.pack.id))
      throw new Error(tr("A theme pack with the ID {id} already exists. Change the Pack ID or use Save as New Pack.", { id: draft.pack.id }));
    const pack = asNew ? { ...structuredClone(draft.pack), id: uniqueId(`custom.${slug(draft.pack.name)}`, taken) } : draft.pack;
    await store.install(pack, draft.assets ?? {});
    const next = { ...draft, pack, installed: true };
    if (asNew) edit(next);
    else setHistory((value) => ({ ...value, present: next }));
    setSaved(JSON.stringify(pack));
    return next;
  };
  const theme = currentTheme(draft);
  const sources = themeSources(kernel);
  const draftId = themeId(draft.pack.id, draft.themeId);
  const applied = kernel.configuration.get<string>("workbench.colorTheme") === draftId;
  const panel = { draft, resolved: lastValid.current, onDraft: edit };

  return (
    <div className="settings-screen theme-editor">
      <div className="settings-heading">
        <h1>{tr("Theme Editor")}</h1>
        <div className="toolbar">
          <Select
            label={tr("Start from")}
            value=""
            options={[
              { value: "", label: tr("Start from..."), disabled: true },
              { value: "new:dark", label: tr("New dark theme") },
              { value: "new:light", label: tr("New light theme") },
              ...sources,
            ]}
            onChange={(value) => {
              const source = sources.find((item) => item.value === value);
              const next = value.startsWith("new:")
                ? newDraft(value === "new:dark" ? "dark" : "light", takenIds(store))
                : source && draftFor(store, source.packId, source.localId);
              if (next) replace(next);
            }}
          />
          {draft.pack.themes.length > 1 && (
            <Select
              label={tr("Theme in pack")}
              value={draft.themeId}
              options={draft.pack.themes.map((item) => ({ value: item.id, label: `${item.name} (${item.mode})` }))}
              onChange={(value) => setHistory((current) => ({ ...current, present: { ...current.present, themeId: value } }))}
            />
          )}
          <span className="muted">
            {draft.installed ? tr("Editing {pack}", { pack: draft.pack.name }) : tr("New pack {id}", { id: draft.pack.id })}
            {dirty ? ` · ${tr("Unsaved changes")}` : ""}
          </span>
        </div>
        <div className="toolbar">
          <button className="button" disabled={!history.past.length} onClick={() => setHistory(({ past, present, future }) => ({ past: past.slice(0, -1), present: past.at(-1)!, future: [present, ...future] }))}>{tr("Undo")}</button>
          <button className="button" disabled={!history.future.length} onClick={() => setHistory(({ past, present, future }) => ({ past: [...past, present], present: future[0], future: future.slice(1) }))}>{tr("Redo")}</button>
          <button className="button primary" disabled={busy || !result.valid || (!dirty && draft.installed)} onClick={() => void perform(async () => tr("Saved {name}.", { name: (await save()).pack.name }))}>{tr("Save")}</button>
          <button className="button" disabled={busy || !result.valid} onClick={() => void perform(async () => tr("Saved a new pack {id}.", { id: (await save(true)).pack.id }))}>{tr("Save as New Pack")}</button>
          <button
            className="button"
            disabled={busy || !result.valid}
            onClick={() => void perform(async () => {
              const next = dirty || !draft.installed ? await save() : draft;
              kernel.configuration.set("workbench.colorTheme", themeId(next.pack.id, next.themeId));
              workbench.touch();
              return tr("Saved and applied {name}.", { name: currentTheme(next).name });
            })}
          >
            {tr("Save and Apply")}
          </button>
          {applied && previous.current && previous.current !== draftId && (
            <button className="button" onClick={() => { kernel.configuration.set("workbench.colorTheme", previous.current); workbench.touch(); }}>{tr("Restore Previous Theme")}</button>
          )}
          <button className="button" disabled={!result.valid} onClick={() => download({ pack: draft.pack, assets: draft.assets ?? {}, enabled: true })}>{tr("Export")}</button>
          <button className="button" onClick={() => edit(addVariant(draft))}>{theme.mode === "dark" ? tr("Add Light Variant") : tr("Add Dark Variant")}</button>
          {draft.pack.themes.length > 1 && <button className="button" onClick={() => edit(removeTheme(draft))}>{tr("Remove {name} from Pack", { name: theme.name })}</button>}
        </div>
        <p role="status" className="theme-editor-status">{status}</p>
        {result.errors.length > 0 && (
          <ul className="theme-editor-problems error-text" aria-label={tr("Errors")}>
            {result.errors.map((item) => <li key={item.path + item.message}>{`${item.path || "/"}: ${item.message}`}</li>)}
          </ul>
        )}
        {result.warnings.length > 0 && (
          <ul className="theme-editor-problems warning-text" aria-label={tr("Warnings")}>
            {result.warnings.map((item) => <li key={item.path + item.message}>{`${item.path}: ${item.message}`}</li>)}
          </ul>
        )}
      </div>
      <div className="theme-editor-body">
        <div className="theme-editor-controls">
          <div className="view-tabs" role="tablist" aria-label={tr("Theme sections")}>
            {TABS.map((item) => (
              <button key={item} role="tab" aria-selected={tab === item} className={tab === item ? "selected" : ""} onClick={() => setTab(item)}>
                {tr(TAB_LABELS[item])}
              </button>
            ))}
          </div>
          {tab === "colors" && (
            <label className="search-input theme-editor-search">
              <input aria-label={tr("Filter colors")} placeholder={tr("Filter colors")} value={query} onChange={(event) => setQuery(event.target.value)} />
            </label>
          )}
          <div role="tabpanel" aria-label={tr(TAB_LABELS[tab])}>
            {tab === "general" && <GeneralPanel {...panel} />}
            {tab === "colors" && <ColorsPanel {...panel} query={query} />}
            {tab === "syntax" && <SyntaxPanel {...panel} />}
            {tab === "typography" && <TypographyPanel {...panel} />}
            {tab === "effects" && <EffectsPanel {...panel} />}
            {tab === "json" && <JsonPanel {...panel} />}
          </div>
        </div>
        <div className="theme-editor-preview">
          <ThemePreview theme={lastValid.current} />
        </div>
      </div>
    </div>
  );
}
