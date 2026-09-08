import { IconPackManager } from "./icon-packs.js";
import { translate as tr } from "@oxbit/ui";
import { useState, useSyncExternalStore } from "react";
import type { Extension, Kernel } from "@oxbit/sdk";
import type { WorkbenchController } from "@oxbit/workbench";
import { Icon, IconButton, OxbitMark } from "@oxbit/ui";
export function Extensions({
  kernel,
  workbench,
}: {
  kernel: Kernel;
  workbench: WorkbenchController;
}) {
  useSyncExternalStore(workbench.subscribe, workbench.snapshot);
  const [query, setQuery] = useState("");
  const extensions = kernel.extensions.list();
  return (
    <div className="extensions-list">
      <div className="search-input">
        <input
          aria-label={tr("Search extensions")}
          placeholder={tr("Search installed extensions")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <IconButton
          icon="plus"
          label={tr("Install extension")}
          onClick={() => void workbench.run("extensions.install")}
        />
      </div>
      <div className="section-label">Icon Packs <button className="button push" onClick={() => void workbench.run("iconPacks.manage")}>Manage Icon Packs</button></div>
      <div className="section-label">
        {tr("Installed")} <span className="push">{extensions.length}</span>
      </div>
      {extensions
        .filter((e) =>
          `${e.manifest.name} ${e.manifest.id}`
            .toLowerCase()
            .includes(query.toLowerCase()),
        )
        .map((e) => (
          <button
            className="extension-card"
            key={e.manifest.id}
            onClick={() =>
              workbench.openView(
                "extension:" + e.manifest.id,
                e.manifest.name,
                ExtensionDetails,
                {
                  id: e.manifest.id,
                  kernel,
                  workbench,
                },
              )
            }
          >
            <span className="extension-icon">
              {e.manifest.id.startsWith("oxbit.") ? (
                <OxbitMark decorative />
              ) : (
                <Icon name="package" size={24} />
              )}
            </span>
            <span>
              <strong>{e.manifest.name}</strong>
              <small>{tr(e.manifest.description || e.manifest.id)}</small>
              <span className="muted">
                {e.manifest.version} · {tr(e.state)}
              </span>
            </span>
            <Icon
              name={
                e.state === "active"
                  ? "check"
                  : e.state === "failed"
                    ? "warning"
                    : "power"
              }
              size={13}
            />
          </button>
        ))}
      <p className="small muted padded">
        {tr(
          "Install a trusted ESM artifact by URL. Extensions execute with this application's browser or runtime privileges.",
        )}
      </p>
    </div>
  );
}
export function ExtensionDetails({
  id,
  kernel,
  workbench,
}: {
  id: string;
  kernel: Kernel;
  workbench: WorkbenchController;
}) {
  useSyncExternalStore(workbench.subscribe, workbench.snapshot);
  const [tab, setTab] = useState("Details"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const record = kernel.extensions.list().find((e) => e.manifest.id === id);
  if (!record)
    return <div className="empty-state">{tr("Extension removed.")}</div>;
  const act = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await operation();
      workbench.touch();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="extension-details">
      <div className="extension-hero">
        <div className="extension-icon">
          {record.manifest.id.startsWith("oxbit.") ? (
            <OxbitMark decorative />
          ) : (
            <Icon name="package" size={44} />
          )}
        </div>
        <div>
          <h1>{record.manifest.name}</h1>
          <p>
            {record.manifest.id}{" "}
            <span className="muted">
              {tr("v")}
              {record.manifest.version}
            </span>
          </p>
          <p>
            {record.manifest.description
              ? tr(record.manifest.description)
              : undefined}
          </p>
          <div className="toolbar">
            <button
              className="button primary"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  const enabling = record.state !== "active";
                  if (!enabling)
                    await kernel.extensions.disable(id);
                  else await kernel.extensions.activate(id);
                  const enabled = (await workbench.persistence.get<string[]>("extension-enabled")) || [];
                  await workbench.persistence.set("extension-enabled", enabling
                    ? [...new Set([...enabled, id])] : enabled.filter((value) => value !== id));
                  const disabled = kernel.extensions
                    .list()
                    .filter((e) => e.state === "disabled")
                    .map((e) => e.manifest.id);
                  await workbench.persistence.set(
                    "extension-disabled",
                    disabled,
                  );
                })
              }
            >
              {busy
                ? tr("Working…")
                : record.state === "active"
                  ? tr("Disable")
                  : record.state === "failed"
                    ? tr("Retry activation")
                    : tr("Enable")}
            </button>
            <button
              className="button"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  if (
                    (await workbench.ask(
                      tr("Remove extension?"),
                      tr("Remove {0}?", { "0": record.manifest.name }),
                      ["Remove", "Cancel"],
                      true,
                    )) === "Remove"
                  ) {
                    await kernel.extensions.remove(id);
                    const enabled = (await workbench.persistence.get<string[]>("extension-enabled")) || [];
                    await workbench.persistence.set("extension-enabled", enabled.filter((value) => value !== id));
                    const artifacts =
                      (await workbench.persistence.get<Record<string, string>>(
                        "extension-artifacts",
                      )) || {};
                    delete artifacts[id];
                    await workbench.persistence.set(
                      "extension-artifacts",
                      artifacts,
                    );
                    const disabled =
                      (await workbench.persistence.get<string[]>(
                        "extension-disabled",
                      )) || [];
                    await workbench.persistence.set("extension-disabled", [
                      ...new Set([...disabled, id]),
                    ]);
                  }
                })
              }
            >
              {tr("Uninstall")}
            </button>
            <button
              className="button"
              onClick={() => void workbench.run("extensions.update", { id })}
            >
              {tr("Update from URL…")}
            </button>
            <button
              className="button"
              onClick={() => void workbench.run("settings.open")}
            >
              {tr("Configure")}
            </button>
          </div>
        </div>
      </div>
      <div className="view-tabs">
        {["Details", "Contributions", "Permissions", "Versions"].map((t) => (
          <button
            key={t}
            className={tab === t ? "selected" : ""}
            onClick={() => setTab(t)}
          >
            {tr(t)}
          </button>
        ))}
      </div>
      {(error || record.error) && (
        <p role="alert" className="error-text">
          {error || record.error}
        </p>
      )}
      <div className="padded">
        {tab === "Details" ? (
          <>
            <h2>{record.manifest.name}</h2>
            <p>
              {record.manifest.description
                ? tr(record.manifest.description)
                : undefined}
            </p>
            <p>
              {tr("SDK compatibility:")} {record.manifest.sdk}
              {tr(". Hosts:")} {record.manifest.environments.join(", ")}.
            </p>
            <p>
              {tr("Activation:")} {record.manifest.activation.join(", ")}.
            </p>
            <p>
              {tr("Status:")} {tr(record.state)}.
            </p>
          </>
        ) : tab === "Contributions" ? (
          <>
            <h2>{tr("Contributions")}</h2>
            {(record.manifest.contributions || []).map((c) => (
              <p key={c.id}>
                <code>{c.kind}</code> {tr(c.title)}
              </p>
            ))}
            {record.manifest.configuration?.map((s) => (
              <p key={s.id}>
                <code>{tr("setting")}</code> {tr(s.title)}
              </p>
            ))}
            {kernel.contributions
              .list()
              .filter(
                (c) =>
                  c.id.startsWith(id) ||
                  (id.includes("bundle") && c.id.includes("bundle")),
              )
              .map((c) => (
                <p key={"active:" + c.id}>
                  {c.kind} · {tr(c.title)}
                </p>
              ))}
          </>
        ) : tab === "Permissions" ? (
          <>
            <h2>{tr("Trusted extension privileges")}</h2>
            <p>
              {tr(
                "Extension code shares the host process and can access its APIs. Declared capabilities describe requested operations; they do not sandbox JavaScript.",
              )}
            </p>
            {record.manifest.capabilities.map((c) => (
              <p key={c}>
                <code>{c}</code>
              </p>
            ))}
          </>
        ) : (
          <>
            <h2>{tr("Installed version")}</h2>
            <p>{record.manifest.version}</p>
            <p>
              {tr(
                "Updates are loaded from a trusted artifact URL and checked for compatible SDK and dependencies.",
              )}
            </p>
          </>
        )}
      </div>
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
      id: "oxbit.extensions",
      name: "Extension Management",
      version: "1.0.0",
      sdk: "^1.0.0",
      environments: ["browser", "embedded"],
      activation: ["*"],
      capabilities: ["extensions"],
    },
    activate(ctx) {
      for (const [id, title, selectKind, importPack] of [
        ["iconPacks.manage", "Manage Icon Packs", undefined, false],
        ["iconPacks.import", "Import Icon Pack…", undefined, true],
        ["iconTheme.select", "File Icon Theme…", "fileIconTheme", false],
        ["productIconTheme.select", "Product Icon Theme…", "productIconTheme", false],
      ] as const) ctx.own(ctx.commands.register({ id, title, category: "Preferences", run: () => workbench.openView("icon-packs", "Icon Packs", IconPackManager, { kernel, workbench, selectKind, selectRequest: Date.now(), importRequest: importPack ? Date.now() : 0 }) }));

      ctx.own(
        ctx.contributions.register({
          id: "extensions.details",
          kind: "documentView",
          title: "Extension Details",
          component: ExtensionDetails,
        }),
      );
      ctx.own(
        ctx.contributions.register({
          id: "extensions",
          kind: "activityView",
          title: "Extensions",
          order: 30,
          component: () => <Extensions kernel={kernel} workbench={workbench} />,
          data: { icon: "ext" },
        }),
      );
      ctx.own(
        ctx.commands.register({
          id: "view.extensions",
          title: "Show Extensions",
          category: "View",
          shortcut: "Ctrl+Shift+X",
          run: () => workbench.openSidebar("extensions"),
        }),
      );
      ctx.own(
        ctx.commands.register({
          id: "extensions.install",
          title: "Install Extension…",
          category: "Extensions",
          run: async () => {
            const url = await workbench.prompt(tr("Trusted extension ESM URL"));
            if (!url) return;
            if (
              (await workbench.ask(
                tr("Trust extension code?"),
                tr(
                  "This code shares the host process and its privileges. Continue only for an artifact you trust.",
                ),
                ["Install", "Cancel"],
              )) !== "Install"
            )
              return;
            const id = await kernel.extensions.load(url);
            await kernel.extensions.activate(id);
            const installed =
              (await workbench.persistence.get<Record<string, string>>(
                "extension-artifacts",
              )) || {};
            await workbench.persistence.set("extension-artifacts", {
              ...installed,
              [id]: url,
            });
            const disabled =
              (await workbench.persistence.get<string[]>(
                "extension-disabled",
              )) || [];
            await workbench.persistence.set(
              "extension-disabled",
              disabled.filter((value) => value !== id),
            );
            workbench.notify(`Installed ${id}`);
          },
        }),
      );
      ctx.own(
        ctx.commands.register({
          id: "extensions.update",
          title: "Update Extension from URL",
          category: "Extensions",
          run: async (args: unknown) => {
            const { id } = args as { id: string };
            const url = await workbench.prompt(tr("Trusted update ESM URL"));
            if (!url) return;
            const mod = await import(/* @vite-ignore */ url);
            const extension = (mod.default || mod.extension) as Extension;
            if (extension.manifest.id !== id)
              throw new Error("Update extension ID does not match.");
            await kernel.extensions.update(extension);
            const installed =
              (await workbench.persistence.get<Record<string, string>>(
                "extension-artifacts",
              )) || {};
            await workbench.persistence.set("extension-artifacts", {
              ...installed,
              [id]: url,
            });
            workbench.notify(`Updated ${id}`);
          },
        }),
      );
      ctx.own(
        ctx.commands.register({
          id: "extensions.checkUpdates",
          title: "Check for Extension Updates",
          category: "Extensions",
          run: () => {
            workbench.openSidebar("extensions");
            workbench.notify(
              "Choose an installed extension and provide its trusted update URL.",
            );
          },
        }),
      );
      ctx.subscribe(kernel.extensions.subscribe(workbench.touch));
    },
  };
}
