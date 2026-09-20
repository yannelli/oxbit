# JSON settings

Oxbit merges settings in this order, from lowest to highest priority:

1. Built-in defaults.
2. `~/.oxbit/settings.json` - user preferences shared across projects.
3. `~/.oxbit/projects/<uuid>/settings.json` - private workspace overrides, using the same UUID as `project.json` and `intelligence.json`.
4. `<project>/.config/oxbit/settings.json` - optional settings you can commit to the repository.
5. `<project>/.config/oxbit/settings.local.json` - optional local overrides with the highest file priority.

Oxbit creates the two private settings files when the workspace settings are first loaded. It only uses the project-root files when you create them manually. Add `.config/oxbit/settings.local.json` to your project's `.gitignore` if you want it to stay untracked; Oxbit does not edit that file for you. UUIDs derive from the canonical workspace root, so a symlink to a project uses the same private settings while moving the project changes its UUID.

Each file contains a plain JSON object with literal setting IDs. Objects merge recursively. Arrays, scalar values and `null` replace the corresponding lower value. A missing key inherits; `null` is a value, not a reset. Individual settings still validate their effective values and fall back when a value is invalid.

For example, user settings:

```json
{
  "editor.tabSize": 2,
  "files.associations": { "*.mdx": "mdx" },
  "languageServers": {
    "json": { "enabled": true, "settings": { "json": { "validate": { "enable": true } } } }
  },
  "[mdx]": { "editor.wordWrap": "on" }
}
```

And private or repository workspace settings:

```json
{
  "editor.tabSize": 4,
  "languageServers": {
    "json": { "settings": { "json": { "schemaDownload": { "enable": false } } } }
  },
  "[mdx]": { "editor.tabSize": 2 },
  "project.intelligence": { "exclude": ["generated/**"], "maxFiles": 10000 },
  "project.schemas": { "download": false }
}
```

The JSON server retains user validation and enabled state while gaining the workspace download preference. Language blocks merge across files too. Existing language-specific precedence remains: user language overrides general workspace settings; workspace language overrides user language. A setting ID such as `editor.tabSize` is a literal JSON key, not a nested `editor` object.

## JSON Schema

The generated [settings schema](../packages/sdk/src/settings.schema.json) describes built-in settings, their types, descriptions, defaults, numeric bounds and enum choices. It also covers language blocks, file associations, language server options, `project.intelligence` and `project.schemas`. Overrides can be partial. Unknown extension setting IDs and server-specific configuration are allowed; known settings still require valid values.

Oxbit automatically associates the schema with all four settings file locations, including custom paths supplied to the runtime. Completion, hover and diagnostics work with schema downloads and SchemaStore disabled, once the JSON language server is available. Explicit custom schema associations and `$schema` declarations retain priority.

Each runtime installs the schema at `~/.oxbit/schemas/settings.v1.schema.json` (beside a custom user settings file when configured). Newly created private settings files include a relative `$schema` reference to that local copy, so external JSON editors can use it offline too. Existing files and manually chosen `$schema` values are preserved. `$schema` is metadata and does not become an effective setting.

For a repository override, Oxbit recognizes the filename without a declaration. An explicit declaration can use the bundled canonical identifier:

```json
{
  "$schema": "https://oxbit.dev/schemas/settings.v1.schema.json",
  "editor.tabSize": 2,
  "[mdx]": { "editor.wordWrap": "on" },
  "project.intelligence": { "maxFiles": 10000 }
}
```

Oxbit resolves that identifier locally. A distributable copy is also included in the web build at `/schemas/settings.v1.schema.json`; publishing the hosted `oxbit.dev` URL is a separate deployment step. For another editor before deployment, reference the installed local schema or a checked-in copy with a relative `$schema` path.

The generator discovers feature configuration modules and reads the same declarations used by Settings and Desktop. Independently added features with a configuration module are included automatically. Run `bun run settings:schema` after changing those declarations and `bun run settings:schema:check` to detect stale generated artifacts. The SDK exports `settingsSchema` and `SETTINGS_SCHEMA_URI`.

## Editing and persistence

The Settings UI's **User** scope writes to the user file. **Workspace** writes to the highest-priority existing workspace file, defaulting to the UUID file. Saves patch only changed properties and preserve other JSON properties. Reset removes the property from the active file, exposing any value inherited from a lower file; it does not delete lower overrides.

Changes on disk reload automatically across connected windows, including atomic editor saves and creation/deletion of optional files. Invalid JSON keeps the last valid contents of that file and reports the problem; Oxbit does not overwrite it. On a fresh runtime, an invalid file contributes no values until fixed. Strict JSON is required: comments and trailing commas are not supported. Files are limited to 256 KiB each.

Settings changes are cached while offline. Different properties changed by different windows merge on save; a conflicting edit to the same property retains the local change and reports a conflict. **Reload Settings from Disk** discards pending changes. **Save Local Settings to Disk** explicitly reapplies only pending changes over current disk values. Saves use process locks and atomic replacement, with revision checks for edits made outside Oxbit. An external editor can still race the final filesystem rename; settings saves are not a multi-file transaction.

Old browser/native preferences and the former `<project>/.oxbit/settings.json` seed the new files only when those files do not already exist. The old files are preserved. Browser-only workspaces retain host storage, since browsers cannot access the user's home directory. Runtime settings belong to the runtime machine and are only exposed to authenticated workspace owners, not collaboration guests.

`project.intelligence` and `project.schemas` override the matching fields in `project.json`, leaving project identity, notes and generated intelligence separate. These runtime preferences apply when the settings files change. See [project intelligence](project-intelligence.md) for supported fields and analysis limits.

For isolated hosts/tests, `OXBIT_SETTINGS_FILE` overrides the user settings path and `OXBIT_PROJECTS_DIR` overrides the private project directory. The runtime constructor also accepts `settingsFile` and `projectsDir`. `settings.read` returns scoped layers and source paths; `settings.patch` accepts property changes with previous values for conflict detection. The SDK exports `mergeSettings`, `settingsLayers`, `settingsFile`, `settingsChanges`, `SettingsLayers`, and `SettingsSnapshot`.

## Verification

Runtime and kernel tests cover precedence, deep merging, language overrides, migration, selective writes/reset, concurrent writers, malformed JSON, confined paths, watchers, project preferences and owner-only access. Persistence tests cover UI-to-file writes, live reload, offline recovery and both conflict resolutions. The production browser journey verifies the Settings UI, two windows, all file levels, reload and deletion fallback. Native desktop execution requires a separate check.

Schema tests check generation freshness, all built-in defaults, partial overrides and invalid values. `bunx tsx scripts/language/settings-schema.ts` exercises the real JSON language server for automatic associations at every location, nested completion, hover, diagnostics, canonical and local `$schema` references with zero remote schema requests. The browser journey also checks the distributable schema and visible project/language completion with downloads disabled.
