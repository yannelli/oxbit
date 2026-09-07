import { useRef, useState, useSyncExternalStore } from "react";
import type { ExtensionContext, Kernel, Disposable } from "@oxbit/sdk";
import {
  resolveTheme,
  validatePack,
  themeId,
  type ThemePackStore,
  type InstalledPack,
} from "@oxbit/themes";
import type { WorkbenchController } from "@oxbit/workbench";
import { bundledPacks } from "./bundled.js";
import { profilePacks } from "./profile.js";
import { readPackFile, exportPack } from "./assets.js";
import { acquireFonts, scopeFonts } from "./fonts.js";
function download(entry: InstalledPack) {
  const result = exportPack(entry.pack, entry.assets);
  const url = URL.createObjectURL(
    new Blob([new Uint8Array(result.bytes)], {
      type: result.extension === "zip" ? "application/zip" : "application/json",
    }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `${entry.pack.id}.${result.extension}`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function ManageThemePacks({
  kernel,
  store,
  workbench,
}: {
  kernel: Kernel;
  store: ThemePackStore;
  workbench: WorkbenchController;
}) {
  useSyncExternalStore(store.subscribe, store.snapshot);
  useSyncExternalStore(workbench.subscribe, workbench.snapshot);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const perform = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
      setStatus("Saved.");
    } catch (error) {
      setStatus(String(error));
    } finally {
      setBusy(false);
    }
  };
  const entries = [
    ...bundledPacks.map((pack) => ({
      pack,
      assets: {},
      enabled: kernel.contributions
        .list("theme")
        .some(
          (t) =>
            (t.data as { resolved?: { packId: string } })?.resolved?.packId ===
            pack.id,
        ),
    })),
    ...store.list(false),
  ];
  return (
    <div className="settings-screen theme-packs">
      <div className="settings-heading">
        <h1>Manage Theme Packs</h1>
        <p className="muted">
          Add your own colors and fonts with a theme pack.
        </p>
        <div className="theme-pack-import">
          <button
            className="button"
            disabled={busy}
            onClick={() => input.current?.click()}
          >
            {busy ? "Importing…" : "Import Theme Pack"}
          </button>
          <span className="muted">JSON or ZIP · up to 50 MB</span>
          <input
            ref={input}
            hidden
            aria-label="Import Theme Pack"
            type="file"
            accept=".json,.zip"
            disabled={busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file)
                void perform(async () => {
                  const result = readPackFile(
                    new Uint8Array(await file.arrayBuffer()),
                    file.name,
                  );
                  await store.install(result.pack, result.assets);
                  setTimeout(
                    () =>
                      setStatus(
                        result.warnings
                          .map((w) => `${w.path}: ${w.message}`)
                          .join("\n") ||
                          "Pack installed. Select Apply to use a theme.",
                      ),
                    0,
                  );
                });
            }}
          />
        </div>
        <p role="status" style={{ whiteSpace: "pre-wrap" }}>
          {status}
        </p>
      </div>
      <div className="settings-list">
        {entries.map((entry) => (
          <section className="setting-row" key={entry.pack.id}>
            <h2>
              {entry.pack.name}{" "}
              <small>
                {entry.pack.version} · {entry.pack.id}
              </small>
            </h2>
            {entry.pack.attribution && (
              <details>
                <summary>Attribution and license</summary>
                <p style={{ whiteSpace: "pre-wrap" }}>
                  {entry.pack.attribution}
                </p>
              </details>
            )}
            <p>
              Fonts:{" "}
              {entry.pack.fonts?.map((f) => `${f.id} (${f.path})`).join(", ") ||
                "System and application fonts"}
            </p>
            <details>
              <summary>Validation: schema and references passed</summary>
              <p>
                {validatePack(entry.pack)
                  .warnings.map((w) => `${w.path}: ${w.message}`)
                  .join("\n") || "No contrast warnings."}
              </p>
            </details>
            <p className="muted">
              {entry.pack.themes
                .map(
                  (t) =>
                    `${t.name}: ${t.mode}${t.highContrast ? " · high contrast" : ""}`,
                )
                .join(" · ")}
            </p>
            <div className="toolbar">
              {entry.pack.themes.map((theme) => (
                <button
                  className="button"
                  key={theme.id}
                  disabled={!entry.enabled}
                  onClick={() => {
                    kernel.configuration.set(
                      "workbench.colorTheme",
                      themeId(entry.pack.id, theme.id),
                    );
                    workbench.touch();
                  }}
                >
                  Apply {theme.name}
                </button>
              ))}
              <button
                className="button"
                onClick={() =>
                  download(
                    store.list().find((p) => p.pack.id === entry.pack.id) ??
                      entry,
                  )
                }
              >
                Export {entry.pack.name}
              </button>
              {!bundledPacks.some((p) => p.id === entry.pack.id) && (
                <>
                  <button
                    className="button"
                    disabled={busy}
                    onClick={() =>
                      void perform(() =>
                        store.enable(entry.pack.id, !entry.enabled),
                      )
                    }
                  >
                    {entry.enabled ? "Disable" : "Enable"} {entry.pack.name}
                  </button>
                  <button
                    className="button"
                    disabled={busy}
                    onClick={() =>
                      void perform(() => store.remove(entry.pack.id))
                    }
                  >
                    Remove {entry.pack.name}
                  </button>
                </>
              )}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
export function migrateLegacyThemes(kernel: Kernel) {
  const aliases = new Map(
    bundledPacks.flatMap((pack) =>
      pack.themes.map(
        (theme) => [theme.name, themeId(pack.id, theme.id)] as const,
      ),
    ),
  );
  const data = kernel.configuration.export() as {
    user: Record<string, unknown>;
    workspace: Record<string, unknown>;
    userLanguages: Record<string, Record<string, unknown>>;
    workspaceLanguages: Record<string, Record<string, unknown>>;
  };
  for (const scope of ["user", "workspace"] as const) {
    for (const [language, layer] of [
      [undefined, data[scope]],
      ...Object.entries(
        data[scope === "user" ? "userLanguages" : "workspaceLanguages"],
      ),
    ] as [string | undefined, Record<string, unknown>][]) {
      const old = layer["workbench.colorTheme"];
      if (typeof old === "string" && aliases.has(old))
        kernel.configuration.set(
          "workbench.colorTheme",
          aliases.get(old),
          scope,
          language,
        );
    }
  }
}
export function attachPackManager(
  ctx: ExtensionContext,
  kernel: Kernel,
  workbench: WorkbenchController,
) {
  const store = profilePacks();
  let contributions: Disposable[] = [];
  let active = true;
  let fontKey = "";
  let fonts: ReturnType<typeof acquireFonts> | undefined;
  const knownModes = new Map(
    bundledPacks.flatMap((pack) =>
      pack.themes.flatMap(
        (t) =>
          [
            [themeId(pack.id, t.id), t.mode],
            [t.name, t.mode],
          ] as const,
      ),
    ),
  );
  ctx.own(
    kernel.services.register("themePacks", {
      store,
      mode: (id: string) => store.mode(id) ?? knownModes.get(id),
    }),
  );
  const updateFonts = () => {
    const id = kernel.configuration.get<string>("workbench.colorTheme");
    const entry = store
      .list()
      .find(
        (p) =>
          p.enabled &&
          p.pack.themes.some((t) => themeId(p.pack.id, t.id) === id),
      );
    const key = entry ? entry.pack.id + ":" + store.snapshot() : "";
    if (key === fontKey) return;
    fontKey = key;
    fonts?.dispose();
    fonts = undefined;
    if (entry) {
      fonts = acquireFonts(entry, (message) =>
        workbench.notify(message, "warning"),
      );
      void fonts.ready.then(() => {
        if (active) {
          workbench.touch();
          document.dispatchEvent(new Event("oxbit-fonts-loaded"));
        }
      });
    }
  };
  const refresh = () => {
    for (const item of contributions) item.dispose();
    contributions = [];
    for (const entry of store.list(false))
      if (entry.enabled)
        for (const theme of entry.pack.themes) {
          const resolved = scopeFonts(
            resolveTheme(entry.pack, theme.id),
            entry,
          );
          contributions.push(
            ctx.contributions.register({
              id: resolved.id,
              kind: "theme",
              title: theme.name,
              data: {
                mode: theme.mode,
                packName: entry.pack.name,
                stableId: resolved.id,
                resolved,
                pairedTheme: resolved.pairedTheme,
              },
            }),
          );
        }
    updateFonts();
    workbench.touch();
  };
  ctx.subscribe(store.subscribe(refresh));
  ctx.subscribe(kernel.configuration.subscribe(updateFonts));
  let migrating = false;
  const migrate = () => {
    if (migrating) return;
    migrating = true;
    try {
      migrateLegacyThemes(kernel);
    } finally {
      migrating = false;
    }
  };
  migrate();
  ctx.subscribe(kernel.configuration.subscribe(migrate));
  const open = () =>
    workbench.openView("theme-packs", "Manage Theme Packs", ManageThemePacks, {
      kernel,
      store,
      workbench,
    });
  for (const [id, title] of [
    ["theme.packs.manage", "Manage Theme Packs"],
    ["theme.packs.import", "Import Theme Pack…"],
    ["theme.packs.export", "Export Theme Pack…"],
  ])
    ctx.own(
      ctx.commands.register({ id, title, category: "Preferences", run: open }),
    );
  void store
    .load()
    .then(() => {
      if (active) refresh();
    })
    .catch((error) =>
      workbench.notify(
        `Theme packs could not be loaded: ${String(error)}`,
        "error",
      ),
    );
  ctx.subscribe(() => {
    active = false;
    fonts?.dispose();
    for (const item of contributions) item.dispose();
  });
}
