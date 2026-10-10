import { languages } from "@oxbit/sdk";
import { translate as tr } from "@oxbit/ui";
import { Fragment, useRef, useState, useSyncExternalStore } from "react";
import type { Extension, ExtensionRecord, Kernel, Setting } from "@oxbit/sdk";
import type { WorkbenchController } from "@oxbit/workbench";
import { Icon, IconButton, Dialog, Select } from "@oxbit/ui";
import { settingsConfiguration } from "./configuration.js";
import { scopedSetting } from "./scopes.js";
import { groupSettings, matchesQuery, splitCategory } from "./layout.js";
import { ActionRow, ServerRow, SettingRow, type SettingAction } from "./rows.js";
import { EditJsonDialog } from "./json-dialog.js";
import { usePhone } from "./use-phone.js";
import { activeKeymap, commandBinding, normalizeShortcut } from "@oxbit/workbench";

const SERVER_PREFIX = "Language Servers · ";
const SERVERS_CATEGORY = `${SERVER_PREFIX}Servers`;
type Entry =
  | { kind: "setting"; category?: string; setting: Setting }
  | { kind: "action"; category: string; action: SettingAction }
  | { kind: "server"; category: string; record: ExtensionRecord };

function sectionLabel(category: string, section: string) {
  const translated = tr(category);
  const at = translated.indexOf(" · ");
  return translated !== category && at >= 0 ? translated.slice(at + 3) : tr(section);
}

export function Settings({
  kernel,
  workbench,
  extension,
}: {
  kernel: Kernel;
  workbench: WorkbenchController;
  /** Shows only the settings this extension declares, including while it is disabled. */
  extension?: string;
}) {
  useSyncExternalStore(workbench.subscribe, workbench.snapshot);
  const [query, setQuery] = useState(""),
    [scope, setScope] = useState<"user" | "workspace">("user"),
    [language, setLanguage] = useState(""),
    [page, setPage] = useState<string>(),
    [modified, setModified] = useState(false),
    [editing, setEditing] = useState(false);
  const phone = usePhone();
  const list = useRef<HTMLDivElement>(null);
  const gitAccounts = useSyncExternalStore(kernel.contributions.subscribe, () => kernel.commands.available("git.account").enabled);
  const records = kernel.extensions.list();
  const owner = extension ? records.find(record => record.manifest.id === extension) : undefined;
  const settings = owner ? owner.manifest.configuration ?? [] : kernel.configuration.list();
  const languageIds = [
    ...new Set([
      ...languages.map(item => item.id),
      "tsx",
      ...kernel.contributions
        .list("language")
        .map((item) => (item.data as { id?: string })?.id)
        .filter((id): id is string => !!id),
    ]),
  ];
  const searching = !!query.trim() || modified;
  const showAll = searching || !!owner;
  const actions: SettingAction[] = owner || modified ? [] : [
    { category: "Appearance", title: tr("Theme Packs"), description: tr("Import and remove theme packs."), label: tr("Manage Theme Packs"), command: "theme.packs.manage" },
    ...(gitAccounts ? [{ category: "Source Control", title: tr("Git Accounts and Commit Author"), description: tr("Sign in to Git hosts and set the name and email used for commits."), label: tr("Manage Git Accounts…"), command: "git.account" }] : []),
  ];
  const servers = owner || searching ? [] : records.filter(record => record.manifest.configuration?.some(setting => setting.category?.startsWith(SERVER_PREFIX)));
  const placeFields = (category?: string) => {
    const { page, section } = splitCategory(category);
    return [tr(page), page, section, section && sectionLabel(category!, section)];
  };
  const entries: Entry[] = [
    ...actions.filter(action => matchesQuery([action.title, action.description, ...placeFields(action.category)], query))
      .map(action => ({ kind: "action" as const, category: action.category, action })),
    ...servers.map(record => ({ kind: "server" as const, category: SERVERS_CATEGORY, record })),
    ...settings
      .filter(s => owner || searching || !s.category?.startsWith(SERVER_PREFIX))
      .filter(s => !modified || scopedSetting(kernel, s, scope, language || undefined).modified)
      .filter(s => matchesQuery([tr(s.title), s.id, s.description && tr(s.description), ...placeFields(s.category)], query))
      .map(setting => ({ kind: "setting" as const, category: setting.category, setting })),
  ];
  const pages = groupSettings(entries);
  const activePage = pages.find(item => item.name === page) ?? (phone ? undefined : pages[0]);
  const shown = showAll ? pages : activePage ? [activePage] : [];
  const count = shown.flatMap(item => item.sections).flatMap(section => section.items).filter(entry => entry.kind === "setting").length;
  const pageList = phone && !showAll && !activePage;
  const choosePage = (name?: string) => {
    setPage(name);
    list.current?.scrollTo?.({ top: 0 });
    if (phone) list.current?.closest(".settings-screen")?.scrollIntoView({ block: "start" });
  };
  const reveal = (selector: string) => list.current?.querySelector(selector)?.scrollIntoView({ block: "start" });
  const renderEntry = (entry: Entry) =>
    entry.kind === "action" ? <ActionRow key={entry.action.command} action={entry.action} workbench={workbench} />
      : entry.kind === "server" ? <ServerRow key={entry.record.manifest.id} record={entry.record} kernel={kernel} workbench={workbench} />
        : <SettingRow key={`${entry.setting.id}:${scope}:${language}`} setting={entry.setting} kernel={kernel} workbench={workbench} scope={scope} language={language || undefined} />;
  return (
    <div className="settings-screen">
      <div className="settings-heading">
        <div className="settings-title-row">
          <h1>{owner ? tr("{0} Settings", { "0": owner.manifest.name }) : tr("Settings")}</h1>
          <button className="button" onClick={() => setEditing(true)}>{tr("Edit as JSON")}</button>
          <div className="settings-segmented" role="group" aria-label={tr("Settings scope")}>
            <button aria-pressed={scope === "user"} onClick={() => setScope("user")}>{tr("User")}</button>
            <button aria-pressed={scope === "workspace"} onClick={() => setScope("workspace")}>{tr("Workspace")}</button>
          </div>
        </div>
        <div className="settings-scope">
          <div className="search-input">
            <Icon name="search" />
            <input aria-label={tr("Search settings")} placeholder={tr("Search settings")} value={query} onChange={(e) => setQuery(e.target.value)} />
            <span className="muted">{count} {tr("settings")}</span>
          </div>
          <Select label={tr("Language override")} value={language} onChange={setLanguage}
            options={[{ value: "", label: tr("All languages") }, ...languageIds.map(value => ({ value, label: value }))]} />
          <label className="settings-chip">
            <input type="checkbox" checked={modified} onChange={(e) => setModified(e.target.checked)} />
            {tr("Modified")}
          </label>
        </div>
      </div>
      <div className="settings-body">
        {!phone && !owner && (
          <nav aria-label={tr("Setting categories")}>
            {pages.map(item => (
              <Fragment key={item.name}>
                <button className={!showAll && item === activePage ? "selected" : ""} aria-current={!showAll && item === activePage ? "page" : undefined}
                  onClick={() => showAll ? reveal(`[data-page="${CSS.escape(item.name)}"]`) : choosePage(item.name)}>
                  {tr(item.name)}
                </button>
                {!showAll && item === activePage && item.sections.filter(section => section.name).map(section => (
                  <button key={section.category} className="settings-nav-section" onClick={() => reveal(`[data-section="${CSS.escape(section.category)}"]`)}>
                    {sectionLabel(section.category, section.name)}
                  </button>
                ))}
              </Fragment>
            ))}
            <button className="settings-nav-keyboard" onClick={() => void workbench.run("settings.keyboard")}>
              <Icon name="keyboard" />{tr("Keyboard Shortcuts")}
            </button>
          </nav>
        )}
        <div className="settings-list" ref={list}>
          {owner && !settings.length && <p className="muted">{tr("This extension has no settings.")}</p>}
          {pageList && (
            <nav className="settings-pages" aria-label={tr("Setting categories")}>
              {pages.map(item => (
                <button key={item.name} onClick={() => choosePage(item.name)}><span>{tr(item.name)}</span><Icon name="chevR" /></button>
              ))}
              <button onClick={() => void workbench.run("settings.keyboard")}><span>{tr("Keyboard Shortcuts")}</span><Icon name="chevR" /></button>
            </nav>
          )}
          {phone && !showAll && activePage && (
            <div className="settings-page-header">
              <IconButton className="icon-button settings-back" icon="chevR" label={tr("All settings")} onClick={() => choosePage(undefined)} />
              <h2>{tr(activePage.name)}</h2>
            </div>
          )}
          {shown.map(item => (
            <Fragment key={item.name}>
              {!(phone && !showAll) && !(owner && shown.length === 1) && <h2 className="settings-page-title" data-page={item.name}>{tr(item.name)}</h2>}
              {item.sections.map(section => (
                <Fragment key={section.category}>
                  {section.name && !(owner && item.sections.length === 1) && <h3 className="settings-section-title" data-section={section.category}>{sectionLabel(section.category, section.name)}</h3>}
                  {section.items.map(renderEntry)}
                </Fragment>
              ))}
            </Fragment>
          ))}
          {searching && !entries.length && <p className="settings-empty muted">{tr("No matching settings")}</p>}
        </div>
      </div>
      {editing && <EditJsonDialog kernel={kernel} workbench={workbench} scope={scope} language={language || undefined} onClose={() => setEditing(false)} />}
    </div>
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
  const keymap = activeKeymap(kernel);
  const binding = (id: string) =>
    commandBinding(
      kernel,
      overrides,
      commands.find((c) => c.id === id) ?? { id },
      keymap,
    );
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
                  <td>
                    {c.id in overrides
                      ? tr("User")
                      : keymap && c.id in keymap.bindings
                        ? tr(keymap.title)
                        : tr("Default")}
                  </td>
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
      id: "oxbit.settings",
      name: "Settings",
      version: "1.0.0",
      sdk: "^1.0.0",
      environments: ["browser", "embedded"],
      activation: ["*"],
      capabilities: [],
      configuration: settingsConfiguration.map(setting => ({ ...setting, enum: setting.enum?.slice() })),
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
        const format = kernel.configuration
          .list()
          .find((setting) => setting.id === "editor.defaultFormatter");
        if (format)
          format.enum = [
            ...new Set([
              "oxbit.prettier",
              "oxbit.builtin-ts",
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
          run: (args) => {
            const extension = (args as { extension?: unknown } | undefined)?.extension;
            const record = typeof extension === "string" ? kernel.extensions.list().find(item => item.manifest.id === extension) : undefined;
            if (record) return workbench.openView(`settings:${record.manifest.id}`, `${record.manifest.name} Settings`, Settings, { kernel, workbench, extension: record.manifest.id });
            return workbench.openView("settings", "Settings", Settings, { kernel, workbench });
          },
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
