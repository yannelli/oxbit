# Tasks, services, and worktree lifecycle

Open **Tasks** in the panel, or run **Manage Tasks and Services** from the command palette. Oxbit discovers configurations without executing them. Grant workspace trust before starting commands, saving configurations, or managing worktrees.

Use **New task** to save a command or a long-running service. Select an entry to inspect/edit its definition. **Run command** is a temporary, unsaved shell command. **Run Build Task** uses a detected task in the `build` group, then a task named `build`; it does not assume a package manager.

The runner shows starting, running, ready, unhealthy, restarting, stopping, stopped, completed, and failed states. Select a run for output, exit status, PID, assigned variables, and detected HTTP(S) links. File/line references in output open the editor. Start is idempotent for an already-active configured task. Restart stops the old run first. Stop signals the entire process group and escalates after the configured timeout; Force stop immediately kills the group. Other processes occupying a requested port are never stopped.

## Storage and imports

New tasks default to the first writable detected configuration in this order:

1. `.oxbit/tasks.json`
2. `paseo.json`
3. `.vscode/tasks.json`, then `.vscode/launch.json`
4. `.run/*.xml`, `.idea/runConfigurations/*.xml`, then `.idea/workspace.xml`
5. `package.json` scripts, `composer.json` scripts, then `Procfile`
6. Private Oxbit configuration: `~/.oxbit/projects/<uuid>/tasks.json`

Editing an imported entry saves back to its own source, regardless of the default. Makefile and `justfile` targets are detected as read-only commands. **Copy to Oxbit** creates an editable Oxbit task. New task names must be unique within their source; dependency names resolve within that source before looking for a unique match across sources. Use the full task ID when a dependency name is ambiguous.

The project UUID is a deterministic version 5 UUID derived from the canonical source checkout (resolved through Git's common directory), or the canonical folder for non-Git projects. Initializing Git in an existing folder keeps its UUID. Repositories using a separate nonstandard Git directory use that directory as their identity. Linked worktrees share private task definitions while each runtime receives independent port assignments. Moving a repository to a different canonical location produces a different UUID. The default is always on the runtime machine, including SSH hosts. `OXBIT_TASKS_HOME` can override the home directory for isolated testing/embedding.

**Save in project…** writes `.oxbit/tasks.json` with the supported imported tasks, environment, and lifecycle scripts. It leaves the original source files and private file intact, reports unsupported entries, and sets `autoDetect: false` to prevent duplicate imports. Review the resulting file in Source Control to commit it. Oxbit does not automatically create a Git commit. Existing `.oxbit/tasks.json` is never overwritten by this export action.

| Format | Supported behavior | Writing behavior |
| --- | --- | --- |
| Oxbit | Commands, services, dependencies, variables, readiness, restart/stop policy, hooks | Native version 1 format |
| Paseo | Named scripts/services, explicit ports; setup → init, teardown → preteardown; Paseo environment aliases | Native command/type/port and setup/teardown updated; extra fields in `oxbit` metadata |
| VS Code tasks | Shell/process/npm commands, platform overrides, cwd/env/args, dependencies, background state, build/test groups | Native task fields updated; advanced settings in per-task `oxbit`; JSONC comments and unrelated fields preserved |
| VS Code launch | Node and Python launch commands, arguments, environment, preLaunchTask | Stored in the existing entry's `oxbit` metadata; original debugger settings preserved |
| JetBrains | Shell, Node.js, Python, npm, Gradle wrapper configurations | Shell command/cwd updated natively; full Oxbit definition in an `OXBIT_TASK` XML option; unrelated nodes/comments retained |
| npm / Composer | Runs through the package manager, retaining lifecycle scripts and Composer callbacks | Script body edited in `scripts`; extra settings in `oxbit.tasks`; Composer arrays remain arrays |
| Procfile | Named, single-line services | Command updated in place; copy to Oxbit for advanced settings |
| Make / Just | Simple named targets/recipes without parameters | Read-only import; edit the original recipe or copy its invocation to Oxbit |

Configurations requiring an IDE debugger, attach session, before-launch IDE steps, custom task provider, interactive `${input:...}` / `${command:...}` variables, or special IDE environment/runtime setup are shown with a reason. They do not execute until explicitly mapped to a runnable command. Diagnostic/problem matchers are not imported. `ready.pattern` is a literal marker, not an IDE regex. Make/Just discovery does not evaluate includes, generated targets, or parameterized recipes. Paseo proxy routing, terminal declarations, and external port allocator scripts are not imported.

Writes validate before modifying the file, compare SHA-256 revisions, preserve unrelated fields, and use an atomic rename. Stale edits fail with the draft retained. Private files use mode 0600. Configuration symlinks are rejected. Discovery is limited to the workspace and the paths above, with a 1 MiB limit per source.

## Oxbit format

The schema is [tasks.v1.schema.json](../apps/web/public/schemas/tasks.v1.schema.json). JSON comments and trailing commas are accepted when reading/editing.

```json
{
  "version": 1,
  "env": { "CACHE_DIR": "${OXBIT_PROJECT_DIR}/.cache" },
  "tasks": {
    "api": {
      "type": "service",
      "command": "npm run api -- --host \"$OXBIT_HOST\" --port \"$OXBIT_PORT\"",
      "port": "auto",
      "ready": {
        "url": "http://$OXBIT_HOST:$OXBIT_PORT/health",
        "timeoutMs": 30000,
        "intervalMs": 500
      },
      "restart": { "policy": "on-failure", "maxAttempts": 3, "delayMs": 1000 },
      "stop": { "signal": "SIGTERM", "timeoutMs": 5000 }
    },
    "web": {
      "type": "service",
      "command": "npm run dev -- --host \"$OXBIT_HOST\" --port \"$OXBIT_PORT\"",
      "env": { "API_URL": "$OXBIT_SERVICE_API_URL" },
      "dependsOn": ["api"],
      "ports": { "INSPECTOR": "auto" }
    },
    "test": {
      "command": "npm test",
      "group": "test",
      "dependsOn": ["api"]
    }
  },
  "worktree": {
    "preinit": "cp \"$OXBIT_SOURCE_DIR/.env\" \"$OXBIT_PREINIT_DIR/.env\"",
    "init": ["cp \"$OXBIT_PREINIT_DIR/.env\" .env", "npm ci"],
    "preteardown": "npm run cleanup",
    "teardown": "echo \"Removed $OXBIT_PROJECT_DIR\""
  }
}
```

A `command` normally runs in the system shell. Use `execution: "process"` with an `args` array to execute an executable directly, preserving each argument literally after variable substitution. Shell `args` are individually quoted. `cwd` defaults to the project and must resolve inside it. Arrays of lifecycle commands run sequentially in one shell with `set -e`, retaining environment/cwd changes across lines. No task runs automatically merely because a project was opened.

Dependencies run sequentially by default (`dependencyOrder: "parallel"` is also available). A command dependency must finish successfully. A service dependency must become ready. Cycles, missing dependencies, and ambiguous references fail before commands launch. Stopping a parent prevents its later launch but leaves dependencies available for other tasks; stop shared services explicitly.

## Assigned variables and ports

| Variable | Meaning |
| --- | --- |
| `OXBIT_PROJECT_ID` | Stable project UUID |
| `OXBIT_WORKSPACE_ID` | Identity of this checkout |
| `OXBIT_PROJECT_DIR`, `OXBIT_WORKTREE_DIR` | Current checkout; during hooks, the target worktree even before creation/after removal |
| `OXBIT_SOURCE_DIR` | Source checkout used to create the worktree |
| `OXBIT_PREINIT_DIR` | Private staging directory, available throughout all four phases |
| `OXBIT_PROJECT_NAME`, `OXBIT_BRANCH`, `OXBIT_TASK_NAME` | Checkout name, branch (empty when detached/non-Git), task name |
| `OXBIT_HOME_DIR`, `OXBIT_RUNTIME_NODE` | Runtime user's home and the bundled/current Node executable |
| `OXBIT_HOST` | Bind address; defaults to `127.0.0.1` |
| `OXBIT_HOSTNAME` | Configured hostname or `<task>-<checkout-hash>.localhost` |
| `OXBIT_PORT`, `OXBIT_URL` | Primary service port and directly reachable HTTP URL |
| `OXBIT_<NAME>_PORT` | Additional named port from `ports` |
| `OXBIT_SERVICE_<TASK>_PORT`, `_HOST`, `_HOSTNAME`, `_URL` | Peer service assignments |
| `OXBIT_SERVICE_<TASK>_<NAME>_PORT` | Peer named port |

Service names become uppercase identifiers, with punctuation converted to underscores; colliding service identifiers are rejected. Services also receive conventional `HOST`/`PORT` variables and compatible `PASEO_*` aliases. Explicit task environment entries can customize conventional variables but cannot replace assigned Oxbit variables. Environment references resolve recursively and cycles are rejected. Process arguments, cwd, env, and readiness URLs accept `$NAME` and `${NAME}`; `$$` escapes a literal dollar. Shell commands retain normal shell quoting and parameter expansion rules. Quote path variables in shell commands.

`port` and each `ports` entry accept `"auto"`, a fixed TCP port, or `{ "min": 3000, "max": 3999 }`. The runtime reserves ports across its service plan, releases the launching service's reservations immediately before spawn, and reserves them again after exit when possible. Assignments remain stable while the runtime lives. Another process can still win the short socket handoff; the service then reports failure rather than taking over that listener. Auto ports can change after a runtime restart. Additional ports are assigned; only the primary port is monitored by default.

Services must actually bind the assigned port. Oxbit does not rewrite application configuration or guess framework CLI flags. Default readiness probes the primary TCP port. `ready.url` probes HTTP(S) and accepts 2xx/3xx status; `ready.pattern` waits for a literal output marker. With only a pattern and no explicit `port`, a non-network worker can become ready from output alone. With a pattern plus an explicit port or URL, both conditions must pass. After readiness, failing probes mark the process unhealthy and recover when probes pass again. Initial readiness timeout kills the process; restart policy applies. Unexpected service exit, even exit 0, is a failed service. Restarts use bounded exponential backoff and stop after the configured attempts (maximum 10); failed health checks after startup show unhealthy without automatically restarting the process.

Generated `.localhost` names are convenient browser links; CLI peer URLs use the actual bind address so they do not depend on wildcard DNS resolution. Custom hostnames require your DNS/application configuration. There is no DNS installation, TLS certificate provisioning, or reverse proxy.

On desktop SSH connections, each launched task's assigned ports are automatically forwarded through the owned SSH connection. Detected links for those ports open local forwarded URLs. Remote processes retain remote addresses in their environment for service-to-service communication. Unassigned/hard-coded ports are not forwarded automatically. The forwards are loopback-only and live until SSH disconnects. Remote projects still need their application tools (such as npm, Python, Git, or a project Node version); `OXBIT_RUNTIME_NODE` provides the automatically installed runtime's Node when useful.

## Worktree operations and recovery

The **Worktrees** tab creates a new branch from a chosen revision, under `~/.oxbit/projects/<uuid>/worktrees/<worktree-uuid>`. It records a snapshot of the lifecycle scripts/environment at creation:

1. `preinit`: private staging cwd; target checkout does not yet exist.
2. Git creates the checkout, then `init`: worktree cwd.
3. Explicit removal runs `preteardown`: worktree cwd, before stopping its tasks/removing files.
4. Git removes the checkout, then `teardown`: staging cwd; the checkout is gone.

An interrupted operation is detected from its former process owner and requires an explicit retry. A failed init retains the checkout and output, with **Retry init**. A failed preteardown prevents removal. A failed post-removal teardown retains staging and supports **Retry teardown**. Staging is deleted only after successful teardown. Hooks have a ten-minute ceiling and can be stopped from their task runs. Removal refuses dirty/untracked worktrees, never passes Git `--force`, only targets registered Oxbit-owned paths, and keeps the branch. Switch back to the source checkout before removing an active worktree. Tasks owned by this runtime in the removed directory are stopped; another Oxbit runtime/session using that worktree should be closed first. Worktrees created/removed outside Oxbit do not trigger these hooks.

Running processes and the last 1 MiB of output per run survive client reconnects, not runtime restarts. The UI marks missing runs as terminated after a restart; it does not silently rerun them. Maximums: 16 simultaneous runs, 128 retained runs, 32 configured services, 16 extra ports per task, and 256 SSH port mappings per connection. Workspace trust revocation and runtime shutdown stop owned task processes. A program that deliberately daemonizes outside its process group is outside this supervision model.

## Verification and implementation references

- `pnpm test:tasks` — config round trips, real process/services, and real Git worktree hooks.
- `pnpm test:tasks:browser` — built browser UI against a real runtime (run `pnpm build` first).
- `pnpm desktop:test:build && pnpm test:tasks:native` — native WebView/private storage workflow.
- `pnpm remote:prepare && pnpm remote:test` — isolated offline SSH fixture, including service port forwarding.

Design references: [Paseo worktree/scripts configuration](https://github.com/getpaseo/paseo/blob/main/public-docs/worktrees.md), [Paseo config schema](https://github.com/getpaseo/paseo/blob/main/packages/protocol/src/paseo-config-schema.ts), [VS Code tasks](https://code.visualstudio.com/docs/debugtest/tasks), [VS Code launch configurations](https://code.visualstudio.com/docs/debugtest/debugging-configuration), and [JetBrains shared run configurations](https://www.jetbrains.com/help/idea/run-debug-configuration.html). This is an independent implementation within Oxbit's existing authenticated runtime and task/output extension.
