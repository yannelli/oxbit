import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ExtensionRecord, Kernel, Setting, SettingSuggestion, SettingSuggestions } from "@oxbit/sdk";
import type { WorkbenchController } from "@oxbit/workbench";
import { IconButton, IconThemeSelect, Select, translate as tr } from "@oxbit/ui";
import { scopedSetting } from "./scopes.js";

/** `last` lists the action after its section's settings. */
export interface SettingAction { category: string; title: string; description: string; label: string; command: string; last?: boolean }

function Row({ className = "", id, title, description, notice, actions, children, error }: {
  className?: string; id?: string; title: string; description?: string; notice?: ReactNode; actions?: ReactNode; children: ReactNode; error?: string;
}) {
  return (
    <section className={`setting-row setting-field ${className}`.trim()} data-setting-id={id}>
      <div className="setting-text">
        <div className="setting-title"><strong>{title}</strong>{actions}</div>
        {description && <p>{description}</p>}
        {notice}
      </div>
      <div className="setting-control">{children}</div>
      {error && <p role="alert" className="error-text">{error}</p>}
    </section>
  );
}

export function ActionRow({ action, workbench }: { action: SettingAction; workbench: WorkbenchController }) {
  return (
    <Row title={action.title} description={action.description}>
      <button className="button" onClick={() => void workbench.run(action.command)}>{action.label}</button>
    </Row>
  );
}

async function setExtensionEnabled(kernel: Kernel, workbench: WorkbenchController, id: string, enabling: boolean) {
  if (enabling) await kernel.extensions.activate(id);
  else await kernel.extensions.disable(id);
  const enabled = (await workbench.persistence.get<string[]>("extension-enabled")) || [];
  await workbench.persistence.set("extension-enabled", enabling ? [...new Set([...enabled, id])] : enabled.filter(value => value !== id));
  await workbench.persistence.set("extension-disabled", kernel.extensions.list().filter(item => item.state === "disabled").map(item => item.manifest.id));
}

export function ServerRow({ record, kernel, workbench }: { record: ExtensionRecord; kernel: Kernel; workbench: WorkbenchController }) {
  const [busy, setBusy] = useState(false);
  const { id, name } = record.manifest;
  const toggle = (enabling: boolean) => {
    setBusy(true);
    void setExtensionEnabled(kernel, workbench, id, enabling)
      .catch(error => workbench.notify(error instanceof Error ? error.message : String(error), "error"))
      .finally(() => { setBusy(false); workbench.touch(); });
  };
  return (
    <Row className="server-row" title={name} description={record.state === "failed" ? record.error : undefined}>
      <input type="checkbox" role="switch" className="setting-switch" aria-label={name} checked={record.state === "active"} disabled={busy}
        onChange={event => toggle(event.target.checked)} />
      <button className="button" aria-label={tr("Configure {0}", { "0": name })} onClick={() => void workbench.run("settings.open", { extension: id })}>
        {tr("Configure")}
      </button>
    </Row>
  );
}

/** The `settingSuggestions` contribution for `id`, loaded again when its key changes. */
function useSuggestions(kernel: Kernel, id: string) {
  const source = kernel.contributions.list("settingSuggestions").map(item => item.data as SettingSuggestions).find(item => item?.setting === id);
  const key = source?.key();
  const [items, setItems] = useState<SettingSuggestion[]>([]);
  useEffect(() => {
    if (!source) return setItems([]);
    const controller = new AbortController();
    source.list(controller.signal).then(setItems, () => !controller.signal.aborted && setItems([]));
    return () => controller.abort();
  }, [source, key]);
  return source ? items : undefined;
}

/** Readable text for an enum value without a schema label: its translation, or the ID split into words. */
export function enumLabel(value: string | number): string {
  const text = String(value), translated = tr(text);
  const words = translated !== text || !/^[A-Za-z][\w.-]*$/.test(text) ? translated
    : text.replace(/([a-z\d])([A-Z])/g, "$1 $2").replace(/[-_.]+/g, " ").toLowerCase();
  return words.charAt(0).toLocaleUpperCase() + words.slice(1);
}

const draftOf = (value: unknown) => (typeof value === "object" ? JSON.stringify(value, null, 2) : String(value));

export function SettingRow({ setting: s, kernel, workbench, scope, language }: {
  setting: Setting; kernel: Kernel; workbench: WorkbenchController; scope: "user" | "workspace"; language?: string;
}) {
  const { value, modified } = scopedSetting(kernel, s, scope, language);
  const [error, setError] = useState(""),
    [draft, setDraft] = useState(draftOf(value));
  const editing = useRef(false), pending = useRef<(() => void) | undefined>(undefined), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const flush = () => {
    clearTimeout(timer.current);
    const commit = pending.current;
    pending.current = undefined;
    commit?.();
  };
  // Typed values save after a pause so each keystroke does not write the settings file.
  const later = (commit: () => void) => {
    pending.current = commit;
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, 400);
  };
  const typing = { onFocus: () => { editing.current = true; }, onBlur: () => { editing.current = false; flush(); } };
  useEffect(() => flush, []);
  useEffect(() => { if (!editing.current) setDraft(draftOf(value)); }, [JSON.stringify(value)]);
  const title = tr(s.title);
  const set = (value: unknown) => {
    try {
      kernel.configuration.set(s.id, value, scope, language);
      setError("");
      workbench.touch();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    }
  };
  const copy = () => void Promise.resolve()
    .then(() => navigator.clipboard.writeText(s.id))
    .then(() => workbench.notify(tr("Copied {0}", { "0": s.id })), (e: unknown) => workbench.notify(String(e), "error"));
  const actions = (
    <span className="setting-actions">
      {modified && <IconButton icon="refresh" label={tr("Reset {0}", { "0": title })} onClick={() => {
        kernel.configuration.reset(s.id, scope, language);
        setError("");
        workbench.touch();
      }} />}
      <IconButton className="icon-button setting-copy" icon="copy" label={tr("Copy setting ID")} onClick={copy} />
    </span>
  );
  const effective = kernel.configuration.inspect(s.id, language);
  const notice = scope === "user" && effective.scope === "workspace" && (
    <p className="setting-override" role="note">
      {tr("The Workspace value {0} overrides this setting.", { "0": JSON.stringify(effective.value) })}{" "}
      <button className="text-button" onClick={() => {
        kernel.configuration.reset(s.id, "workspace", language);
        workbench.touch();
      }}>{tr("Remove Workspace value")}</button>
    </p>
  );
  const suggestions = useSuggestions(kernel, s.id);
  const iconTheme = s.id === "workbench.iconTheme" || s.id === "workbench.productIconTheme";
  const stringList = s.type === "array" && s.items === "string" && Array.isArray(value);
  const stacked = !!suggestions?.length || stringList || s.type === "object" || s.type === "array";
  const control = s.type === "boolean" ? (
    <input type="checkbox" role="switch" className="setting-switch" aria-label={title} checked={!!value} onChange={event => set(event.target.checked)} />
  ) : stringList ? (
    <StringChips label={title} value={(value as unknown[]).map(String)} invalid={!!error} onChange={set} />
  ) : s.type === "object" || s.type === "array" ? (
    <textarea aria-label={title} aria-invalid={!!error} value={draft} rows={Math.min(8, Math.max(3, draft.split("\n").length))} spellCheck={false} {...typing} onChange={event => {
      const text = event.target.value;
      setDraft(text);
      later(() => { try { set(JSON.parse(text)); } catch (error) { setError(String(error)); } });
    }} />
  ) : s.id === "workbench.colorTheme" ? (
    <Select label={title} value={String(value)} onChange={set} options={kernel.contributions.list("theme").map(item => ({ value: (item.data as { stableId?: string })?.stableId ?? item.id, label: `${item.title} · ${(item.data as { packName?: string })?.packName ?? item.owner ?? item.id}` }))} />
  ) : iconTheme ? (
    <>
      <IconThemeSelect kernel={kernel} kind={s.id === "workbench.iconTheme" ? "fileIconTheme" : "productIconTheme"} value={String(value)} onChange={set} />
      <button className="button" onClick={() => void workbench.run("iconPacks.import")}>Import Icon Pack…</button>
    </>
  ) : s.enum ? (
    <Select label={title} value={String(value)} onChange={value => set(s.type === "number" ? Number(value) : value)}
      options={s.enum.map((value, index) => ({ value: String(value), label: s.enumLabels?.[index] ? tr(s.enumLabels[index]) : enumLabel(value) }))} />
  ) : (
    <input aria-label={title} type={s.type === "number" ? "number" : "text"} min={s.min} max={s.max} value={draft} aria-invalid={!!error} {...typing}
      onChange={event => {
        const text = event.target.value;
        setDraft(text);
        if (s.type === "number" && !text.trim()) {
          pending.current = undefined;
          setError(tr("Enter a number."));
          return;
        }
        later(() => set(s.type === "number" ? Number(text) : text));
      }} />
  );
  const choose = (next: string) => {
    pending.current = undefined;
    setDraft(next);
    set(next);
  };
  const suggested = !!suggestions?.length && (
    <ul className="setting-suggestions" aria-label={tr("Suggestions for {0}", { "0": title })}>
      {suggestions.map(item => (
        <li key={item.value}>
          <button type="button" className="setting-suggestion" aria-pressed={value === item.value} title={[item.value, item.title ?? item.detail].filter(Boolean).join("\n")} onClick={() => choose(item.value)}>
            <span>{item.label}</span>
            {item.detail && <small>{item.detail}</small>}
          </button>
        </li>
      ))}
    </ul>
  );
  const variant = [stacked ? "stacked" : "", s.type === "boolean" ? "switch-row" : "", modified ? "modified" : ""].filter(Boolean).join(" ");
  return (
    <Row className={variant} id={s.id} title={title} description={s.description ? tr(s.description) : undefined} notice={notice} actions={actions} error={error}>
      {control}
      {suggested}
    </Row>
  );
}

export function StringChips({ label, value, invalid, onChange }: { label: string; value: string[]; invalid: boolean; onChange(value: string[]): boolean }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const item = draft.trim();
    if (!item) return;
    if (value.includes(item) || onChange([...value, item])) setDraft("");
  };
  return (
    <div className="setting-chips" role="group" aria-label={label}>
      {value.length > 0 && (
        <ul className="setting-chip-list">
          {value.map((item, index) => (
            <li key={`${index}:${item}`} className="setting-chip-item">
              <span>{item}</span>
              <IconButton icon="x" label={tr("Remove {0}", { "0": item })} onClick={() => onChange(value.filter((_, at) => at !== index))} />
            </li>
          ))}
        </ul>
      )}
      <div className="setting-chip-add">
        <input aria-label={tr("Add to {0}", { "0": label })} placeholder={tr("Add…")} aria-invalid={invalid} value={draft} spellCheck={false}
          autoCapitalize="off" autoCorrect="off" onChange={event => setDraft(event.target.value)}
          onKeyDown={event => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            add();
          }} />
        <IconButton icon="plus" label={tr("Add")} disabled={!draft.trim()} onClick={add} />
      </div>
    </div>
  );
}
