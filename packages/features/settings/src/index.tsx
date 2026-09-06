import { translate as tr } from "@zapp/ui";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { Extension, Kernel, Setting } from "@zapp/sdk";
import type { WorkbenchController } from "@zapp/workbench";
import { Icon, IconButton, Dialog } from "@zapp/ui";
import schema from "./schema.json";
import { scopedSetting } from "./scopes.js";
import { normalizeShortcut } from "@zapp/workbench";
export function Settings({
  kernel,
  workbench,
}: {
  kernel: Kernel;
  workbench: WorkbenchController;
}) {
  useSyncExternalStore(workbench.subscribe, workbench.snapshot);
  const [query, setQuery] = useState(""),
    [scope, setScope] = useState<"user" | "workspace">("user"),
    [language, setLanguage] = useState(""),
    [category, setCategory] = useState("All"),
    [modified, setModified] = useState(false);
  const settings = kernel.configuration.list();
  const languageIds = [
    ...new Set([
      "typescript",
      "tsx",
      "javascript",
      "json",
      "css",
      "html",
      "markdown",
      ...kernel.contributions
        .list("language")
        .map((item) => (item.data as { id?: string })?.id)
        .filter((id): id is string => !!id),
    ]),
  ];
  const categories = [
    ...new Set(settings.map((s) => s.category || "Extensions")),
  ];
  const selected = settings.filter(
    (s) =>
      (category === "All" || s.category === category) &&
      (!modified ||
        scopedSetting(kernel, s, scope, language || undefined).modified) &&
      `${tr(s.title)} ${s.id} ${s.description ? tr(s.description) : undefined}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  return (
    <div className="settings-screen">
      <div className="settings-heading">
        <h1>{tr("Settings")}</h1>
        <div className="search-input">
          <Icon name="search" />
          <input
            aria-label={tr("Search settings")}
            placeholder={tr("Search settings")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <span className="muted">
            {selected.length} {tr("settings")}
          </span>
        </div>
        <div className="settings-scope">
          <button
            aria-pressed={scope === "user"}
            onClick={() => setScope("user")}
          >
            {tr("User")}
          </button>
          <button
            aria-pressed={scope === "workspace"}
            onClick={() => setScope("workspace")}
          >
            {tr("Workspace")}
          </button>
          <select
            aria-label={tr("Language override")}
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
          >
            <option value="">{tr("All languages")}</option>
            {languageIds.map((l) => (
              <option key={l}>{l}</option>
            ))}
          </select>
          <label className="push">
            <input
              type="checkbox"
              checked={modified}
              onChange={(e) => setModified(e.target.checked)}
            />{" "}
            {tr("Modified")}
          </label>
          <button onClick={() => void workbench.run("settings.keyboard")}>
            {tr("Keyboard Shortcuts")}
          </button>
        </div>
      </div>
      <div className="settings-body">
        <nav aria-label={tr("Setting categories")}>
          <button
            className={category === "All" ? "selected" : ""}
            onClick={() => setCategory("All")}
          >
            {tr("All Settings")}
          </button>
          {categories.map((c) => (
            <button
              key={c}
              className={category === c ? "selected" : ""}
              onClick={() => setCategory(c)}
            >
              {tr(c)}
            </button>
          ))}
        </nav>
        <div className="settings-list">
          {selected.map((s) => (
            <SettingRow
              key={`${s.id}:${scope}:${language}`}
              setting={s}
              kernel={kernel}
              workbench={workbench}
              scope={scope}
              language={language || undefined}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
function SettingRow({
  setting: s,
  kernel,
  workbench,
  scope,
  language,
}: {
  setting: Setting;
  kernel: Kernel;
  workbench: WorkbenchController;
  scope: "user" | "workspace";
  language?: string;
}) {
  const { value, modified } = scopedSetting(kernel, s, scope, language);
  const [error, setError] = useState(""),
    [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const set = (value: unknown) => {
    try {
      kernel.configuration.set(s.id, value, scope, language);
      setError("");
      workbench.touch();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <section className={`setting-row ${modified ? "modified" : ""}`}>
      <div className="setting-title">
        <span className="muted">{tr(s.category || "Extension")}: </span>
        <strong>{tr(s.title)}</strong>
        <IconButton
          icon="refresh"
          label={tr("Reset {0}", { "0": tr(s.title) })}
          onClick={() => {
            kernel.configuration.reset(s.id, scope, language);
            setError("");
            workbench.touch();
          }}
        />
      </div>
      <p>{s.description ? tr(s.description) : undefined}</p>
      {s.type === "boolean" ? (
        <label>
          <input
            type="checkbox"
            checked={!!value}
            onChange={(e) => set(e.target.checked)}
          />
          {tr(s.title)}
        </label>
      ) : s.enum ? (
        <select
          aria-label={tr(s.title)}
          value={String(value)}
          onChange={(e) =>
            set(s.type === "number" ? Number(e.target.value) : e.target.value)
          }
        >
          {s.enum.map((v) => (
            <option key={String(v)} value={String(v)}>
              {typeof v === "string" ? tr(v) : v}
            </option>
          ))}
        </select>
      ) : (
        <input
          aria-label={tr(s.title)}
          type={s.type === "number" ? "number" : "text"}
          min={s.min}
          max={s.max}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            if (s.type === "number" && !e.target.value.trim()) {
              setError(tr("Enter a number."));
              return;
            }
            set(s.type === "number" ? Number(e.target.value) : e.target.value);
          }}
          aria-invalid={!!error}
        />
      )}
      <div className="setting-id">
        {s.id}
        {modified ? tr(" · Modified") : ""}
      </div>
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
    </section>
  );
}
export function KeyboardShortcuts({
  kernel,
  workbench,
}: {
  kernel: Kernel;
  workbench: WorkbenchController;
}) {
  const state = useSyncExternalStore(workbench.subscribe, workbench.snapshot);
  const [query, setQuery] = useState(""),
    [capture, setCapture] = useState<string>(),
    [keys, setKeys] = useState("");
  const commands = kernel.commands.list();
  const overrides = (state as any).keybindings || {};
  const binding = (id: string) =>
    overrides[id] ?? commands.find((c) => c.id === id)?.shortcut ?? "";
  const conflicts = commands.filter(
    (c) =>
      c.id !== capture &&
      normalizeShortcut(binding(c.id)) === normalizeShortcut(keys) &&
      keys,
  );
  const save = (replace: boolean) => {
    const next = { ...overrides, [capture!]: keys };
    if (replace) for (const c of conflicts) next[c.id] = "";
    workbench.set({ keybindings: next } as any);
    setCapture(undefined);
  };
  return (
    <div className="keyboard-screen">
      <h1>{tr("Keyboard Shortcuts")}</h1>
      <div className="search-input">
        <Icon name="search" />
        <input
          aria-label={tr("Search keyboard shortcuts")}
          placeholder={tr("Search keyboard shortcuts")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <table>
        <thead>
          <tr>
            <th>{tr("Command")}</th>
            <th>{tr("Keybinding")}</th>
            <th>{tr("Source")}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {commands
            .filter((c) =>
              `${tr(c.title)} ${c.title} ${c.id} ${binding(c.id)}`
                .toLowerCase()
                .includes(query.toLowerCase()),
            )
            .map((c) => {
              const duplicate = commands.some(
                (x) =>
                  x.id !== c.id &&
                  binding(x.id) &&
                  binding(x.id) === binding(c.id),
              );
              return (
                <tr key={c.id}>
                  <td>
                    {tr(c.title)}
                    <small>{c.id}</small>
                  </td>
                  <td>
                    <kbd>{binding(c.id) || "—"}</kbd>
                    {duplicate && (
                      <span className="warning-text"> {tr("Conflict")}</span>
                    )}
                  </td>
                  <td>{c.id in overrides ? tr("User") : tr("Default")}</td>
                  <td>
                    <IconButton
                      icon="pencil"
                      label={tr("Change shortcut for {0}", {
                        "0": tr(c.title),
                      })}
                      onClick={() => {
                        setCapture(c.id);
                        setKeys("");
                      }}
                    />
                    <IconButton
                      icon="refresh"
                      label={tr("Reset shortcut for {0}", { "0": tr(c.title) })}
                      onClick={() => {
                        const next = { ...overrides };
                        delete next[c.id];
                        workbench.set({ keybindings: next } as any);
                      }}
                    />
                  </td>
                </tr>
              );
            })}
        </tbody>
      </table>
      {capture && (
        <Dialog
          title={tr("Record shortcut")}
          onClose={() => setCapture(undefined)}
        >
          <p>
            {tr(
              "Press the keys to assign. Separate chords with a second key combination.",
            )}
          </p>
          <input
            aria-label={tr("Record shortcut")}
            readOnly
            value={keys}
            placeholder={tr("Press keys…")}
            onKeyDown={(e) => {
              if (e.key === "Escape") return;
              e.preventDefault();
              e.stopPropagation();
              if (["Control", "Meta", "Alt", "Shift"].includes(e.key)) return;
              const key = [
                e.ctrlKey || e.metaKey ? "Ctrl" : null,
                e.shiftKey ? "Shift" : null,
                e.altKey ? "Alt" : null,
                e.key === " "
                  ? "Space"
                  : e.key.length === 1
                    ? e.key.toUpperCase()
                    : e.key,
              ]
                .filter(Boolean)
                .join("+");
              setKeys((prev) =>
                prev && prev.split(" ").length < 2 ? prev + " " + key : key,
              );
            }}
          />
          {conflicts.length > 0 && (
            <p className="warning-text">
              {tr("Used by")} {conflicts.map((c) => tr(c.title)).join(", ")}
            </p>
          )}
          <div className="dialog-actions">
            <button className="button" onClick={() => setKeys("")}>
              {tr("Clear")}
            </button>
            {conflicts.length > 0 && (
              <button className="button" onClick={() => save(true)}>
                {tr("Replace existing")}
              </button>
            )}
            <button
              className="button primary"
              disabled={!keys}
              onClick={() => save(false)}
            >
              {conflicts.length ? tr("Keep both") : tr("Save")}
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
export function createFeature({
  kernel,
  workbench,
}: {
  kernel: Kernel;
  workbench: WorkbenchController;
}): Extension {
  return {
    manifest: {
      manifestVersion: 1,
      id: "zapp.settings",
      name: "Settings",
      version: "1.0.0",
      sdk: "^1.0.0",
      environments: ["browser", "embedded"],
      activation: ["*"],
      capabilities: [],
      configuration: [
        ...(schema as Setting[]),
        {
          id: "workbench.locale",
          title: "Display Language",
          type: "string",
          default: "en",
          enum: ["en", "de"],
          category: "Appearance",
        },
        {
          id: "workbench.reducedMotion",
          title: "Reduced Motion",
          type: "boolean",
          default: false,
          category: "Appearance",
        },
      ],
    },
    activate(ctx) {
      ctx.own(
        ctx.contributions.register({
          id: "settings",
          kind: "tab",
          title: "Settings",
          component: Settings,
        }),
      );
      ctx.own(
        ctx.contributions.register({
          id: "keyboard",
          kind: "tab",
          title: "Keyboard Shortcuts",
          component: KeyboardShortcuts,
        }),
      );
      const refreshOptions = () => {
        const theme = kernel.configuration
          .list()
          .find((setting) => setting.id === "workbench.colorTheme");
        if (theme)
          theme.enum = [
            ...new Set([
              "Graphite (dark)",
              "Paper (light)",
              ...kernel.contributions.list("theme").map((item) => item.title),
            ]),
          ];
        const format = kernel.configuration
          .list()
          .find((setting) => setting.id === "editor.defaultFormatter");
        if (format)
          format.enum = [
            ...new Set([
              "zapp.prettier",
              "zapp.builtin-ts",
              ...kernel.contributions
                .list("formatter")
                .map((item) => (item.data as { id?: string })?.id || item.id),
            ]),
          ];
      };
      refreshOptions();
      ctx.subscribe(kernel.contributions.subscribe(refreshOptions));

      ctx.own(
        ctx.commands.register({
          id: "settings.open",
          title: "Open Settings",
          category: "Preferences",
          shortcut: "Ctrl+,",
          run: () =>
            workbench.openView("settings", "Settings", Settings, {
              kernel,
              workbench,
            }),
        }),
      );
      ctx.own(
        ctx.commands.register({
          id: "settings.keyboard",
          title: "Open Keyboard Shortcuts",
          category: "Preferences",
          shortcut: "Ctrl+K Ctrl+S",
          run: () =>
            workbench.openView(
              "keyboard",
              "Keyboard Shortcuts",
              KeyboardShortcuts,
              {
                kernel,
                workbench,
              },
            ),
        }),
      );
      ctx.subscribe(kernel.configuration.subscribe(() => workbench.touch()));
    },
  };
}
