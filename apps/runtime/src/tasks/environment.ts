import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { RpcError } from "@oxbit/protocol";
import type { ConfiguredTask } from "@oxbit/sdk";
import type { TaskConfigStore } from "./config.js";
import { serviceUrl, type TaskPorts } from "./ports.js";
export function expand(
  value: string,
  env: Record<string, string | undefined>,
  strict = true,
) {
  return value.replace(
    /\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (match, braced, bare) => {
      if (match === "$$") return "$";
      const key = braced ?? bare;
      if (env[key] === undefined && strict)
        throw new RpcError(
          "UNRESOLVED_VARIABLE",
          `Variable ${key} is not defined`,
        );
      return env[key] ?? "";
    },
  );
}
export function taskEnvironment(
  store: TaskConfigStore,
  task: ConfiguredTask,
  ports: TaskPorts,
  catalog: { tasks: ConfiguredTask[]; env: Record<string, string> },
  context: {
    root?: string;
    projectDir?: string;
    sourceDir?: string;
    preinitDir?: string;
    branch?: string;
  } = {},
) {
  const root = context.projectDir ?? context.root ?? store.root,
    plan = ports.get(task.id);
  const variables: Record<string, string> = {
    OXBIT_PROJECT_ID: store.projectId,
    OXBIT_WORKSPACE_ID: createHash("sha256")
      .update(root)
      .digest("hex")
      .slice(0, 24),
    OXBIT_PROJECT_DIR: root,
    OXBIT_WORKTREE_DIR: root,
    OXBIT_PROJECT_NAME: path.basename(root),
    OXBIT_SOURCE_DIR: context.sourceDir ?? store.root,
    OXBIT_PREINIT_DIR:
      context.preinitDir ??
      path.join(
        store.projectHome,
        "preinit",
        createHash("sha256").update(root).digest("hex").slice(0, 16),
      ),
    OXBIT_HOME_DIR: os.homedir(),
    OXBIT_RUNTIME_NODE: process.execPath,
    OXBIT_TASK_NAME: task.name,
    OXBIT_BRANCH: context.branch ?? "",
    OXBIT_HOST: plan?.host ?? "127.0.0.1",
    OXBIT_HOSTNAME: plan?.hostname ?? "localhost",
    ...ports.peers(catalog.tasks),
  };
  if (plan) {
    variables.OXBIT_PORT = String(plan.port);
    variables.OXBIT_URL = serviceUrl(plan);
    for (const [name, port] of Object.entries(plan.ports))
      variables[`OXBIT_${name.toUpperCase()}_PORT`] = String(port);
  }
  const env: NodeJS.ProcessEnv = { ...process.env, ...variables };
  // Paseo imports keep working without rewriting the user's shell expressions.
  env.PASEO_SOURCE_CHECKOUT_PATH = variables.OXBIT_SOURCE_DIR;
  env.PASEO_WORKTREE_PATH = root;
  env.PASEO_ROOT_PATH = variables.OXBIT_SOURCE_DIR;
  env.PASEO_BRANCH_NAME = variables.OXBIT_BRANCH;
  env.PASEO_WORKSPACE_ID = variables.OXBIT_WORKSPACE_ID;
  env.PASEO_SCRIPTNAME = task.name;
  if (plan) {
    env.PASEO_PORT = variables.OXBIT_PORT;
    env.PASEO_URL = variables.OXBIT_URL;
    env.PASEO_WORKTREE_PORT = variables.OXBIT_PORT;
    env.PORT = variables.OXBIT_PORT;
    env.HOST = variables.OXBIT_HOST;
  }
  for (const [key, value] of Object.entries(variables))
    if (key.startsWith("OXBIT_SERVICE_"))
      env[key.replace("OXBIT_", "PASEO_")] = value;
  const custom = { ...catalog.env, ...task.env },
    resolved = new Set<string>(),
    resolving = new Set<string>();
  function resolve(key: string): string {
    if (resolved.has(key)) return env[key]!;
    if (resolving.has(key))
      throw new RpcError(
        "UNRESOLVED_VARIABLE",
        `Environment variable cycle at ${key}`,
      );
    if (Object.hasOwn(variables, key))
      throw new RpcError(
        "INVALID_TASK_CONFIG",
        `${key} is assigned by Oxbit and cannot be overridden`,
      );
    resolving.add(key);
    const value = custom[key];
    for (const match of value.matchAll(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    )) {
      const other = match[1] ?? match[2];
      if (other !== key && Object.hasOwn(custom, other)) resolve(other);
    }
    env[key] = expand(value, env);
    resolving.delete(key);
    resolved.add(key);
    return env[key]!;
  }
  for (const key of Object.keys(custom)) resolve(key);
  return { env, variables };
}
export function detectLinks(text: string): string[] {
  const clean = text
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  const found = new Set<string>();
  for (const match of clean.matchAll(/https?:\/\/[^\s<>"'\x00-\x1f]+/g)) {
    const raw = match[0].replace(/[),.;\]}]+$/, "");
    try {
      const url = new URL(raw);
      if (!url.username && !url.password) {
        if (["0.0.0.0", "[::]"].includes(url.hostname))
          url.hostname = "localhost";
        found.add(url.href);
      }
    } catch {
      /* Partial output can finish in the next chunk. */
    }
  }
  return [...found].slice(0, 32);
}
