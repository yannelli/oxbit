# Project intelligence and additional language support

Every runtime workspace has a private directory at `~/.oxbit/projects/<uuid>/`. The UUID is derived from the canonical workspace file URI, so reopening the same directory or a symlink to it uses the same identity. Moving a project to a different canonical path creates another identity. `OXBIT_PROJECTS_DIR` and the runtime's `projectsDir` option override the parent directory for tests or other installations.

- `project.json` is the editable user configuration. Oxbit creates it once and preserves it during analysis.
- `intelligence.json` is generated data: file inventory, language IDs, npm and Composer dependency declarations, recognized frameworks, top-level script symbols and imports. It contains metadata, not source text or environment-variable values.

Open **Project Intelligence** from the command palette to inspect the current project's packages and the active file's imports, direct dependents, transitive dependents and matching test/source filenames. Related-file buttons open the corresponding source. The runtime refreshes analysis after filesystem changes, with a 500 ms debounce; **Refresh analysis** forces a refresh. Analysis uses saved files. Unsaved document intelligence continues to come from the language servers.

## User configuration

General editor preferences now live in [merged settings files](settings.md), including
`~/.oxbit/projects/<uuid>/settings.json`. The `project.intelligence` and `project.schemas`
keys override the matching fields below; project identity and notes remain in `project.json`.

The generated identity fields must remain unchanged. For example:

```json
{
  "schemaVersion": 1,
  "id": "<generated UUID>",
  "root": "/absolute/project/path",
  "name": "My project",
  "notes": "Project-specific context for future work.",
  "intelligence": {
    "enabled": true,
    "exclude": ["generated/**", "fixtures/large/**"],
    "maxFiles": 20000,
    "maxFileBytes": 1048576
  },
  "schemas": {
    "catalog": true,
    "download": true,
    "associations": []
  }
}
```

Directories and files use private permissions. Invalid configuration is reported and is never overwritten with defaults. Changes to this file refresh the index and restart running JSON servers to apply schema preferences; stopped servers remain stopped.

The scanner respects nested `.gitignore` files, explicit exclusions, common dependency/build directories and filesystem authorization. Symlinks are skipped. Source reads are bounded to 32 MiB per scan, with configurable per-file and file-count limits. The index reports truncation and skipped analysis. Imports are extracted statically from JavaScript/TypeScript and script regions in MDX, Vue and Astro. Resolution includes relative modules, available TypeScript configuration/path aliases and local npm workspace exports. Dependency declarations come from `package.json` and `composer.json`.

This index does not evaluate applications. Dynamic imports with computed names, runtime dependency injection, PHP class/reference graphs and semantic/embedding search are not inferred. A reverse-import path is a possible dependency relationship, not proof that a change breaks each dependent. Dependency versions are declared constraints, not an audit of the installed lockfile.

## Automatic JSON schemas

JSON/JSONC servers discover filename associations using the [SchemaStore catalog](https://www.schemastore.org/api/json/catalog.json). Standard files such as `package.json`, `composer.json` and `tsconfig*.json` receive schema completion, hover and validation without manual setup. A document's `$schema` selects its explicit schema; relative workspace schemas and nested `$ref` references work too. Local schema edits invalidate the server's schema cache.

Catalog and schema content is downloaded on demand over HTTPS and cached in `<language-server-cache>/json-schemas/`, normally `~/.oxbit/language-servers/json-schemas/`. Entries retain their original schema URL for relative reference resolution, a timestamp and a content checksum. Downloads are bounded, duplicate requests share work, writes are atomic, and expired entries remain usable offline. The refresh interval is 24 hours. A cold offline cache still supplies common filename associations but cannot provide unavailable schema content.

`schemas.catalog: false` disables catalog discovery. `schemas.download: false` permits cached and workspace-local schemas without network downloads. `schemas.associations` accepts JSON-server schema associations, for example:

```json
[
  {
    "fileMatch": ["app.config.json"],
    "url": "https://example.com/app.schema.json"
  }
]
```

The existing `languageServers.json.settings.json.schemas` setting remains supported. Explicit associations exclude the corresponding automatic filename associations. Per-language-server `json.schemaStore.enable` and `json.schemaDownload.enable` can also disable their respective automatic behavior. Workspace schema file requests retain the runtime's path boundary.

## MDX

The `mdx` registry entry selects the pinned [`@mdx-js/language-server` 0.6.4](https://github.com/mdx-js/mdx-analyzer/tree/main/packages/language-server), installed automatically through the existing managed installer. Its TypeScript integration is enabled and uses the project SDK when available, with a managed SDK fallback. MDX has Markdown/JSX syntax fallback, a distinct file badge/settings scope and Prettier's MDX parser.

The syntax fallback and static project index do not implement full MDX compilation semantics.

## Laravel and Blade

The official [`laravel/lsp` 0.0.31](https://github.com/laravel/lsp/releases/tag/v0.0.31) standalone binaries are pinned with SHA-256 integrity for Apple Silicon macOS and Linux x64. The installer does not require a global Composer installation. PHP files inside an `artisan` root use Laravel alongside Intelephense; `.blade.php` files have the `blade` language ID and use Laravel with PHP/HTML syntax fallback. Plain PHP projects continue using Intelephense alone. Nested `composer.json` files do not displace the Laravel application's `artisan` root.

Laravel's server inspects a running project through its PHP environment. The application's dependencies and supported PHP environment must be available. It runs only through the existing trusted-runtime LSP boundary. The upstream auto-detection can be overridden using `languageServers.laravel.initializationOptions.phpEnvironment` or `phpCommand`, for example:

```json
{
  "laravel": {
    "initializationOptions": {
      "phpCommand": ["/absolute/path/to/php"]
    }
  }
}
```

The pinned server supports named-route completion, route hover, view definitions into Blade, and Blade directive snippets. Blade `@include` string completion is a known limitation.

## Runtime API and verification

Project RPCs require an authenticated workspace owner with filesystem-read capability; the user configuration is not disclosed to guest sessions.

| RPC | Result |
|---|---|
| `project.info` | Configuration, storage directory, analysis status and counts |
| `project.refresh` | Refresh saved-file analysis, then return project info |
| `project.intelligence` | Generated data with a paginated `files` array; `offset` defaults to 0 and `limit` to 50 (maximum 200); `totalFiles` reports the full count |
| `project.relations` | Imports, direct/reachable dependents and related files for `path` |

```sh
bunx vitest run apps/runtime/tests/projects.test.ts apps/runtime/tests/json-schemas.test.ts apps/runtime/tests/lsp-manager.test.ts
bunx tsx scripts/language/project-intelligence.ts
bun run --filter @oxbit/web build
bunx playwright test --config scripts/language/project-playwright.config.ts
```

For a real Laravel application, create a disposable Composer project in a directory named `oxbit-laravel-acceptance.*`, run `php artisan package:discover`, then run `scripts/language/laravel-intelligence.ts` with `OXBIT_LARAVEL_FIXTURE` pointing to it. That script deliberately modifies fixture routes/views. `OXBIT_LSP_REPORT` saves real-server results. The managed-server CI workflow includes the MDX and Laravel presets and the MDX/schema/project checks.
