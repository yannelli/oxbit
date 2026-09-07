# Extension SDK 1.0

Import extension contracts from `@oxbit/sdk`. `SDK_VERSION` is `1.0.0`. Public types cover commands, context, configuration, contributions, services, typed events, save hooks, manifests, filesystem adapters, persistence, language transports and document edits. `languageIdForPath(path)` returns the standard language ID for supported file extensions. `pnpm build:sdk` generates the browser ESM facade from these public exports.

`examples/bundle-inspector` uses SDK exports and React. Extension ID `orbitlabs.bundle-inspector` adds `bundle.analyze`, panel `bundle`, settings, status item, output channel and document view `bundle.report`. Analyze measures disk file bytes and gzip bytes. The report opens through `workbench.openView`; disablement closes it and cancels analysis. Module counts come from source maps. Files without source maps show that state.

Build the external artifact with `pnpm --filter @oxbit/bundle-inspector exec vite build`. The output is `examples/bundle-inspector/dist/bundle-inspector.js`. It imports bare `react`, which the web host must map to its own React facade. Install its served URL through the Extensions view. Development source URLs use Vite's module server.

The default directory is `dist`. If it is absent or empty, analysis uses workspace files. It skips `.git`, `node_modules` and `.oxbit`, stops after 2,000 files, and gzip-compresses text files up to 2 MB with the browser compression API. Larger and unreadable files show unmeasured gzip. Reported source sizes use the filesystem's encoding and line endings. This is a file report; transformed module attribution requires a source map.

## Package contract

Export an `Extension` as the ESM default or named `extension` export. Declare `manifestVersion: 1`, unique ID, SemVer version, SDK range, environments, activation triggers, capabilities and dependency ranges. Core checks SDK compatibility, host support, dependency versions and cycles.

```ts
import type { Extension } from '@oxbit/sdk';

export default {
  manifest: {
    manifestVersion: 1,
    id: 'example.hello',
    name: 'Hello',
    version: '1.0.0',
    sdk: '^1.0.0',
    environments: ['browser', 'embedded'],
    activation: ['onCommand:hello.show'],
    capabilities: [],
  },
  activate(ctx) {
    ctx.commands.register({
      id: 'hello.show',
      title: 'Hello: Show',
      run: () => 'Hello',
    });
  },
} satisfies Extension;
```

`extensions.load(url)` loads a trusted HTTP(S) or file ESM artifact and activates it. Use `extensions.load(url, {activate: false})` to register it for declared lazy triggers. Browser artifacts must bundle dependencies or use host-resolved imports. Vite development URLs support TypeScript sources. Node hosts support file URLs. Package-manager installation and a public marketplace are deferred.

Register built-ins with `register(extension)` and `trigger('onStartup')`. `*` runs on the next trigger. Command execution triggers `onCommand:<id>`. Document opens emit language triggers; workspace opens emit `onWorkspace`. Panels and restored views emit `onView:<id>`. Declare optional manifest `commands` metadata to show lazy commands in palettes before activation. Browser startup restores artifacts before layout, then follows their startup, workspace, language and view triggers. `activate(id)` enables disabled extensions and retries failed activation.

## Registration and teardown

Manifest settings stay registered from installation through removal, so disabled extensions remain configurable. Their saved values survive removal. Manifest UI contributions register during activation. Imperative activation-owned settings and components dispose on disablement. Register dynamic components through `ctx.contributions.register` and omit those IDs from the manifest. Duplicate command, setting, contribution, hook, service and extension IDs fail.

Context registrations belong to the extension. Use `ctx.own(disposable)` or `ctx.subscribe(cleanup)` for custom resources. `ctx.signal` aborts on activation failure, disablement and kernel disposal. Tasks must check this signal. Disposal releases resources in reverse order and keeps user settings and documents. Event listener errors are logged; other listeners still run. Command and hook errors reject the caller.

Failed activation removes its registrations and records the error. Disabling a dependency disables active dependents. Updates check SDK and dependent version ranges. A failed active update restores the earlier implementation.

## Commands and settings

Palette, menu, toolbar and shortcut actions call `commands.execute`. Context expressions support keys, `!`, `&&`, `||`, parentheses, booleans and literal equality or inequality. Contributions sort by ascending `order`, descending `priority`, then ID. Shortcut conflicts sort by descending priority, descending context length, then ID. Shortcut contributions declare `command` and `data.key`.

Settings check type, finite numeric bounds and enum values. Precedence is defaults, user, workspace, user-language, workspace-language. Reset removes a scoped override. Invalid stored values fall through to a valid lower layer. The kernel stores configuration through its persistence adapter.

## Hooks and services

Services use string IDs and `get<T>` or `optional<T>`. Events use the SDK `EventMap`. Save hooks sort by order then ID and run sequentially, passing returned text to the next hook. The total default deadline is 5 seconds. Cancellation aborts the hook signal and rejects saving. Recursive saves fail. A document edit during hooks rejects saving so the user can retry with current text. Hook code must check cancellation before side effects.

## Trusted code

Browser ESM shares page privileges; runtime ESM shares Node process privileges. Manifest capabilities do not sandbox code. Runtime requests require workspace grants. Exception handling cannot stop an infinite loop or process exit. Load reviewed artifacts.

Native packaging and React Native are deferred. Before claiming Paseo v0.7.0 compatibility, test its exact lifecycle, theme, layout, filesystem, process, transport and disposal APIs. Debugging and AI implementations are deferred.

## Provider contributions

Register a contribution with its typed provider in `data`. Providers enter the
same workflows as built-in features; removal stops new requests and clears
owned results.

| Kind | SDK data type | Consumer |
| --- | --- | --- |
| `filesystem` | `FileSystemProvider` | Open Workspace lists the provider; `open()` returns its filesystem. |
| `language` | `LanguageDefinition` | Matching file extensions select the language and CodeMirror extensions. |
| `transport` | `LanguageTransportProvider` | Language services select a matching transport and manage its lifetime. |
| `diagnostics` | `DiagnosticsProvider` | Version-checked results appear in editor diagnostics and Problems. |
| `completion` | `CompletionProvider` | Matching documents receive contributed completion items. |
| `codeAction` | `CodeActionProvider` | Contributed actions join the editor's code-action workflow. |
| `formatter` | `Formatter` | Formatter selection and save hooks use matching language providers. |
| `editorDecoration` | `EditorDecorationContribution` | Matching editors mount and remove CodeMirror extensions. |

A filesystem returned by `FileSystemProvider.open()` transfers to the workspace
host until that workspace closes. Give it a stable `id` for draft and layout
recovery. Do not tie that returned instance to the provider activation signal:
switching workspaces disposes the previous extension host. Disabling the
provider prevents future opens. The host calls the filesystem's optional
`dispose()` when its workspace closes.

The formatter coordinator, Prettier, and TypeScript formatter register as
separate extensions. Prettier and the TypeScript compiler run in browser
workers. Formatter settings and save hooks use the document's language scope.
Provider cancellation stops owned worker requests.

## Workbench contributions

Menus use `location` for a named menu or context surface. Shortcuts use
`command` plus `data.key`. Toolbar items use a component or command. Tabs and
custom document views mount their components in editor groups; view metadata
selects matching paths. Themes supply semantic CSS tokens, and icon
contributions supply SVG paths. See [the public types](../packages/sdk/src/index.ts)
and [the original surface contract](../design/extension-surfaces.md).

Workbench notifications accept an optional timeout and up to three command
actions. Command IDs route those actions through the command registry.
`workspace.change` identifies opened and closed workspaces;
`connection.change` reports the runtime connection state;
`terminal.change` reports terminal lifecycle changes.
