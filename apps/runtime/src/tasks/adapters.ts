import path from "node:path";
import {
  parse,
  parseTree,
  findNodeAtLocation,
  modify,
  applyEdits,
  type ParseError,
} from "jsonc-parser";
import {
  DOMParser,
  XMLSerializer,
  type Element,
  type Document,
} from "@xmldom/xmldom";
import type { TaskDefinition, TaskHooks, TaskSourceKind } from "@oxbit/sdk";
import {
  definition,
  hooks,
  invalid,
  object,
  shellQuote,
  stringMap,
  taskName,
} from "./validation.js";
export interface ImportedTask {
  name: string;
  definition: TaskDefinition;
  sourceCommand?: string;
  disabledReason?: string;
}
export interface ImportedSource {
  tasks: ImportedTask[];
  worktree: TaskHooks;
  env: Record<string, string>;
  diagnostics: string[];
}
export function json(text: string) {
  const errors: ParseError[] = [];
  const result = parse(text, errors, { allowTrailingComma: true });
  if (errors.length) invalid(`Invalid JSON near offset ${errors[0].offset}`);
  return object(result, "configuration");
}
export function editJson(
  text: string,
  location: (string | number)[],
  value: unknown,
) {
  const tree = value === undefined ? parseTree(text) : undefined;
  if (value === undefined && (!tree || !findNodeAtLocation(tree, location)))
    return text;
  return applyEdits(
    text,
    modify(location.length ? text : text || "{}", location, value, {
      formattingOptions: {
        insertSpaces: true,
        tabSize: 2,
        eol: text.includes("\r\n") ? "\r\n" : "\n",
      },
    }),
  );
}
function normalizeVariables(value: string) {
  return value
    .replaceAll("$PROJECT_DIR$", "${OXBIT_PROJECT_DIR}")
    .replaceAll("$ProjectFileDir$", "${OXBIT_PROJECT_DIR}")
    .replaceAll("${workspaceFolder}", "${OXBIT_PROJECT_DIR}")
    .replaceAll("${workspaceRoot}", "${OXBIT_PROJECT_DIR}")
    .replaceAll("${workspaceFolderBasename}", "${OXBIT_PROJECT_NAME}")
    .replaceAll("${userHome}", "${OXBIT_HOME_DIR}")
    .replaceAll("${pathSeparator}", path.sep)
    .replaceAll("${/}", path.sep)
    .replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, "${$1}");
}
function normalizeTask(task: TaskDefinition): TaskDefinition {
  const result = structuredClone(task);
  result.command = normalizeVariables(result.command);
  if (result.cwd) result.cwd = normalizeVariables(result.cwd);
  if (result.args) result.args = result.args.map(normalizeVariables);
  if (result.env)
    result.env = Object.fromEntries(
      Object.entries(result.env).map(([k, v]) => [k, normalizeVariables(v)]),
    );
  return result;
}
function nativeVariables(value: string, kind: "vscode" | "jetbrains") {
  return value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
    (match, key: string) => {
      if (kind === "jetbrains")
        return key === "OXBIT_PROJECT_DIR" ? "$PROJECT_DIR$" : match;
      const names: Record<string, string> = {
        OXBIT_PROJECT_DIR: "workspaceFolder",
        OXBIT_PROJECT_NAME: "workspaceFolderBasename",
        OXBIT_HOME_DIR: "userHome",
      };
      return "${" + (names[key] ?? "env:" + key) + "}";
    },
  );
}
function quotePath(value: string) {
  return normalizeVariables(value)
    .split(/(\$\{[A-Za-z_][A-Za-z0-9_]*\})/)
    .map((part) => (/^\$\{/.test(part) ? `"${part}"` : shellQuote(part)))
    .join("");
}
export function xml(text: string): Document {
  if (/<!DOCTYPE|<!ENTITY/i.test(text))
    invalid("XML document types and entities are not supported");
  return new DOMParser({
    onError: (level, message) => {
      if (level !== "warning")
        invalid(`Invalid run configuration XML: ${message}`);
    },
  }).parseFromString(text, "application/xml");
}
function children(element: Element, tag: string): Element[] {
  return Array.from(element.childNodes).filter(
    (node): node is Element =>
      node.nodeType === 1 && (node as Element).tagName === tag,
  );
}
function options(element: Element) {
  return Object.fromEntries(
    children(element, "option").map((e) => [
      e.getAttribute("name")!,
      e.getAttribute("value") ?? "",
    ]),
  );
}
function option(doc: Document, parent: Element, name: string, value: string) {
  let item = children(parent, "option").find(
    (node) => node.getAttribute("name") === name,
  );
  if (!item) {
    item = doc.createElement("option");
    item.setAttribute("name", name);
    parent.appendChild(item);
  }
  item.setAttribute("value", value);
}
function jetbrains(element: Element): ImportedTask {
  const name = element.getAttribute("name") || "Unnamed configuration",
    type = element.getAttribute("type"),
    values = options(element);
  const setting = (name: string, nativeName = name) =>
    values[name] ??
    element.getAttribute(nativeName) ??
    children(element, nativeName)[0]?.getAttribute("value") ??
    "";
  let task: TaskDefinition = { command: "" },
    disabledReason: string | undefined;
  const envs = Array.from(element.getElementsByTagName("env"));
  const env = Object.fromEntries(
    envs.map((node) => [
      node.getAttribute("name")!,
      node.getAttribute("value") ?? "",
    ]),
  );
  if (type === "ShConfigurationType") {
    task.command =
      values.EXECUTE_SCRIPT_FILE === "false" || !values.SCRIPT_PATH
        ? (values.SCRIPT_TEXT ?? "")
        : `${quotePath(values.INTERPRETER_PATH || "/bin/sh")} ${quotePath(values.SCRIPT_PATH)} ${values.SCRIPT_OPTIONS || ""}`;
    task.cwd = values.SCRIPT_WORKING_DIRECTORY || undefined;
  } else if (type === "NodeJSConfigurationType") {
    const program = setting("JS_FILE_PATH", "path-to-js-file");
    task.command = `${quotePath(values.NODE_INTERPRETER || "node")} ${setting("NODE_OPTIONS", "node-parameters")} ${quotePath(program)} ${setting("APPLICATION_PARAMETERS", "application-parameters")}`;
    task.cwd = setting("WORKING_DIRECTORY", "working-dir") || undefined;
    if (!program) disabledReason = "Node run configuration has no script path";
  } else if (type === "PythonConfigurationType") {
    task.command = `${quotePath(values.SDK_HOME || "python3")} ${values.INTERPRETER_OPTIONS || ""} ${values.MODULE_MODE === "true" ? "-m " : ""}${quotePath(values.SCRIPT_NAME || "")} ${values.PARAMETERS || ""}`;
    task.cwd = values.WORKING_DIRECTORY || undefined;
  } else if (type === "js.build_tools.npm") {
    const scripts = Array.from(element.getElementsByTagName("script"))
      .map((node) => node.getAttribute("value"))
      .filter((v): v is string => !!v);
    task.command = scripts
      .map(
        (script) =>
          `${quotePath(setting("packageManager", "package-manager") || "npm")} run ${shellQuote(script)} ${setting("arguments")}`,
      )
      .join(" && ");
    const manifest = setting("package-json");
    task.cwd = manifest ? path.dirname(manifest) : undefined;
  } else if (type === "GradleRunConfiguration") {
    const settings = Array.from(
      element.getElementsByTagName("ExternalSystemSettings"),
    )[0];
    const settingsValues = settings ? options(settings) : {};
    const names = settings
      ? Array.from(settings.getElementsByTagName("option")).find(
          (node) => node.getAttribute("name") === "taskNames",
        )
      : undefined;
    const goals = names
      ? Array.from(names.getElementsByTagName("option"))
          .map((node) => node.getAttribute("value"))
          .filter((v): v is string => !!v)
      : [];
    task = {
      command: "./gradlew",
      execution: "process",
      args: goals,
      cwd: settingsValues.externalProjectPath,
    };
    if (settingsValues.scriptParameters || settingsValues.vmOptions)
      disabledReason =
        "Gradle custom VM/script parameters need an explicit Oxbit command";
  } else
    disabledReason = `${type || "This IDE configuration"} requires an IDE/debug adapter; add an explicit Oxbit command to enable it`;
  task.env = env;
  const before = Array.from(element.getElementsByTagName("method"))
    .flatMap((node) => children(node, "option"))
    .filter((node) => node.getAttribute("enabled") === "true");
  if (before.length)
    disabledReason =
      "Before-launch IDE steps require an explicit command/dependency mapping";
  if (values.OXBIT_TASK) {
    task = { ...task, ...json(values.OXBIT_TASK) };
    disabledReason = undefined;
  }
  return { name, definition: normalizeTask(task), disabledReason };
}
export function readSource(kind: TaskSourceKind, text: string): ImportedSource {
  const result: ImportedSource = {
    tasks: [],
    worktree: {},
    env: {},
    diagnostics: [],
  };
  const add = (
    name: string,
    task: TaskDefinition,
    extra: Partial<ImportedTask> = {},
  ) => {
    taskName(name);
    const normalized = normalizeTask(task);
    const unresolved = JSON.stringify(normalized).match(
      /\$\{(?:input|command|config|workspaceFolder):[^}]+\}|\$\{(?:file|relativeFile|selectedText|lineNumber)[^}]*\}|\$[A-Z][A-Z_]+\$/,
    );
    result.tasks.push({
      name,
      definition: normalized,
      ...extra,
      ...(unresolved && !extra.disabledReason
        ? {
            disabledReason: `Unresolved IDE variable ${unresolved[0]}; replace it with an Oxbit variable or a value`,
          }
        : {}),
    });
  };
  if (kind === "jetbrains") {
    const doc = xml(text);
    for (const element of Array.from(
      doc.getElementsByTagName("configuration"),
    )) {
      if (element.getAttribute("default") === "true") continue;
      const task = jetbrains(element);
      add(task.name, task.definition, { disabledReason: task.disabledReason });
    }
    const meta = Array.from(doc.getElementsByTagName("component")).find(
      (node) => node.getAttribute("name") === "OxbitTasks",
    );
    if (meta) {
      const values = options(meta);
      result.worktree = hooks(values.worktree ? json(values.worktree) : {});
      result.env = values.env ? stringMap(json(values.env), "env") : {};
    }
  } else if (kind === "procfile") {
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^([\w-]+):\s*(.+)$/);
      if (match) add(match[1], { command: match[2], type: "service" });
    }
  } else if (kind === "make" || kind === "just") {
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(
        kind === "make"
          ? /^([A-Za-z_][\w.-]*):(?:\s|$)/
          : /^([A-Za-z_][\w-]*):\s*(?:#.*)?$/,
      );
      if (match)
        add(match[1], {
          command: kind,
          execution: "process",
          args: [match[1]],
        });
    }
    result.diagnostics.push(
      "Detected targets are read-only. Copy a task to Oxbit to customize it; edit recipes in their source file.",
    );
  } else {
    const data = json(text);
    const meta = object(data.oxbit ?? {}, "oxbit metadata");
    result.env = stringMap(
      (kind === "oxbit" ? data.env : meta.env) ?? {},
      "env",
    );
    result.worktree = hooks(kind === "oxbit" ? data.worktree : meta.worktree);
    if (kind === "oxbit") {
      if (data.version !== 1)
        invalid("Unsupported Oxbit tasks version (expected 1)");
      for (const key of Object.keys(data))
        if (
          ![
            "$schema",
            "version",
            "autoDetect",
            "tasks",
            "env",
            "worktree",
          ].includes(key)
        )
          invalid(`Unknown Oxbit configuration field: ${key}`);
      for (const [name, task] of Object.entries(
        object(data.tasks ?? {}, "tasks"),
      ))
        add(name, definition(task));
    } else if (kind === "paseo") {
      result.worktree = {
        ...hooks({
          init: data.worktree?.setup,
          preteardown: data.worktree?.teardown,
        }),
        ...result.worktree,
      };
      for (const [name, value] of Object.entries(
        object(data.scripts ?? {}, "scripts"),
      )) {
        const script = object(value, name);
        add(
          name,
          definition({
            command: script.command,
            type: script.type === "service" ? "service" : "command",
            ...(script.port !== undefined ? { port: script.port } : {}),
            ...script.oxbit,
          }),
        );
      }
      if (data.worktree?.servicePorts)
        result.diagnostics.push(
          "Paseo servicePorts is not executed. Configure an Oxbit port range per service.",
        );
    } else if (kind === "vscode-launch") {
      if (!Array.isArray(data.configurations))
        invalid("VS Code launch configurations must be an array");
      for (const entry of data.configurations) {
        const platform =
          process.platform === "darwin"
            ? "osx"
            : process.platform === "win32"
              ? "windows"
              : "linux";
        const item = { ...entry, ...entry[platform] };
        const python = ["python", "debugpy"].includes(item.type);
        let disabledReason: string | undefined;
        if (
          item.request !== "launch" ||
          !["node", "pwa-node", "python", "debugpy"].includes(item.type)
        )
          disabledReason =
            "This launch configuration requires a debugger/attach session; provide an explicit command to run it";
        if (
          item.envFile ||
          item.postDebugTask ||
          item.runtimeVersion ||
          item.console === "externalTerminal" ||
          (item.module && !python)
        )
          disabledReason =
            "This launch configuration uses IDE environment, runtime, or lifecycle features that need an explicit task mapping";
        const task: TaskDefinition = {
          command: python
            ? ((Array.isArray(item.python) ? item.python[0] : item.python) ??
              "python3")
            : (item.runtimeExecutable ?? "node"),
          execution: "process",
          args: [
            ...(python
              ? Array.isArray(item.python)
                ? item.python.slice(1)
                : []
              : (item.runtimeArgs ?? [])),
            ...(item.module && python
              ? ["-m", item.module]
              : item.program
                ? [item.program]
                : []),
            ...(item.args ?? []),
          ],
          cwd: item.cwd,
          env: item.env,
          ...(item.preLaunchTask ? { dependsOn: [item.preLaunchTask] } : {}),
          ...item.oxbit,
        };
        add(item.name ?? "Unnamed launch", task, {
          disabledReason: item.oxbit?.command ? undefined : disabledReason,
        });
      }
      result.diagnostics.push(
        "Launch configurations run as commands; debugger attachment and breakpoints are not provided by Tasks.",
      );
    } else if (kind === "vscode") {
      if (data.version !== "2.0.0")
        invalid("Only VS Code tasks version 2.0.0 is supported");
      if (!Array.isArray(data.tasks)) invalid("VS Code tasks must be an array");
      for (const raw of data.tasks) {
        const entry = object(raw, "VS Code task"),
          platform =
            process.platform === "darwin"
              ? "osx"
              : process.platform === "win32"
                ? "windows"
                : "linux";
        const item = { ...entry, ...entry[platform] };
        const args = (item.args ?? []).map((arg: unknown) =>
          typeof arg === "string" ? arg : object(arg, "argument").value,
        );
        const opts = { ...data.options, ...item.options };
        let command = item.command ?? data.command ?? "",
          execution: "shell" | "process" =
            item.type === "process" ? "process" : "shell";
        let disabledReason: string | undefined;
        if (item.type === "npm") {
          command = "npm";
          execution = "process";
          args.push("run", item.script);
        } else if (item.type && !["shell", "process"].includes(item.type))
          disabledReason = `VS Code task provider ${item.type} is unavailable; provide an explicit command`;
        if (opts.shell?.executable || opts.shell?.args)
          disabledReason =
            "Custom VS Code shell needs an explicit process command";
        const task: TaskDefinition = {
          command,
          execution,
          args,
          cwd:
            opts.cwd ??
            (item.path ? "${OXBIT_PROJECT_DIR}/" + item.path : undefined),
          env: opts.env,
          type: item.isBackground ? "service" : "command",
          dependsOn:
            typeof item.dependsOn === "string"
              ? [item.dependsOn]
              : item.dependsOn,
          dependencyOrder: item.dependsOrder ?? "parallel",
          ...(item.group
            ? {
                group:
                  typeof item.group === "string" ? item.group : item.group.kind,
              }
            : {}),
          ...item.oxbit,
        };
        if (task.group && !["build", "test"].includes(task.group))
          delete task.group;
        if (item.problemMatcher)
          result.diagnostics.push(
            `${item.label}: diagnostic matchers are not imported; configure ready.pattern for a literal readiness marker.`,
          );
        add(item.label ?? item.script ?? "Unnamed task", task, {
          disabledReason: item.oxbit?.command ? undefined : disabledReason,
        });
      }
    } else {
      for (const [name, script] of Object.entries(
        object(data.scripts ?? {}, "scripts"),
      )) {
        if (
          typeof script !== "string" &&
          !(kind === "composer" && Array.isArray(script))
        )
          continue;
        const task = {
          command: kind === "composer" ? "composer" : "npm",
          execution: "process" as const,
          args: [kind === "composer" ? "run-script" : "run", name],
          ...meta.tasks?.[name],
        };
        add(name, task, {
          sourceCommand:
            typeof script === "string" ? script : JSON.stringify(script),
        });
      }
    }
  }
  if (result.tasks.length > 256) invalid("Maximum 256 tasks per configuration");
  const names = new Set<string>();
  for (const task of result.tasks) {
    if (names.has(task.name)) invalid(`Duplicate task name: ${task.name}`);
    names.add(task.name);
    if (!task.disabledReason) task.definition = definition(task.definition);
  }
  return result;
}
export function writeTask(
  kind: TaskSourceKind,
  text: string,
  name: string,
  task: TaskDefinition | undefined,
  sourceCommand?: string,
): string {
  if (kind === "make" || kind === "just")
    invalid("Recipe imports are read-only; copy to Oxbit to customize");
  if (kind === "jetbrains") {
    const doc = xml(text);
    let target = Array.from(doc.getElementsByTagName("configuration")).find(
      (node) => node.getAttribute("name") === name,
    );
    if (!task) {
      target?.parentNode?.removeChild(target);
      return new XMLSerializer().serializeToString(doc);
    }
    if (!target) {
      target = doc.createElement("configuration");
      target.setAttribute("name", name);
      target.setAttribute("type", "ShConfigurationType");
      target.setAttribute("factoryName", "Shell Script");
      doc.documentElement!.appendChild(target);
    }
    if (target.getAttribute("type") === "ShConfigurationType") {
      option(
        doc,
        target,
        "SCRIPT_TEXT",
        nativeVariables(task.command, "jetbrains"),
      );
      option(doc, target, "EXECUTE_SCRIPT_FILE", "false");
      if (task.cwd)
        option(
          doc,
          target,
          "SCRIPT_WORKING_DIRECTORY",
          nativeVariables(task.cwd, "jetbrains"),
        );
    }
    option(doc, target, "OXBIT_TASK", JSON.stringify(task));
    return new XMLSerializer().serializeToString(doc);
  }
  if (kind === "procfile") {
    if (
      task &&
      (task.command.includes("\n") ||
        Object.keys(task).some((key) => !["command", "type"].includes(key)))
    )
      invalid(
        "Procfile supports a single-line service command. Copy to Oxbit for advanced settings.",
      );
    if (!/^[\w-]+$/.test(name))
      invalid(
        "Procfile names must contain letters, numbers, hyphens or underscores",
      );
    const lines = text.split(/\r?\n/),
      index = lines.findIndex((line) => line.startsWith(name + ":"));
    if (index >= 0) {
      if (task) lines[index] = `${name}: ${task.command}`;
      else lines.splice(index, 1);
    } else if (task) lines.push(`${name}: ${task.command}`);
    return lines.join("\n");
  }
  const data = json(text);
  if (kind === "oxbit") return editJson(text, ["tasks", name], task);
  if (kind === "paseo") {
    if (!task) return editJson(text, ["scripts", name], undefined);
    let next = editJson(text, ["scripts", name, "command"], task.command);
    next = editJson(next, ["scripts", name, "type"], task.type ?? "command");
    next = editJson(
      next,
      ["scripts", name, "port"],
      typeof task.port === "number" ? task.port : undefined,
    );
    return editJson(next, ["scripts", name, "oxbit"], task);
  }
  if (kind === "vscode-launch") {
    let index = (data.configurations ?? []).findIndex(
      (t: any) => t.name === name,
    );
    if (index < 0) {
      if (!task) return text;
      index = data.configurations?.length ?? 0;
      text = editJson(text, ["configurations", index], {
        name,
        type: "node",
        request: "launch",
        runtimeExecutable: task.command,
      });
    }
    if (!task) return editJson(text, ["configurations", index], undefined);
    return editJson(text, ["configurations", index, "oxbit"], task);
  }
  if (kind === "vscode") {
    let index = (data.tasks ?? []).findIndex(
      (t: any) => (t.label ?? t.script) === name,
    );
    if (index < 0) {
      if (!task) return text;
      index = data.tasks?.length ?? 0;
      text = editJson(text, ["tasks", index], {
        label: name,
        type: "shell",
        command: task.command,
      });
    }
    if (!task) return editJson(text, ["tasks", index], undefined);
    let next = text;
    for (const [key, value] of Object.entries({
      command: nativeVariables(task.command, "vscode"),
      type: task.execution === "process" ? "process" : "shell",
      args: (task.args ?? []).map((arg) => nativeVariables(arg, "vscode")),
      isBackground: task.type === "service",
      dependsOn: task.dependsOn ?? [],
      dependsOrder: task.dependencyOrder ?? "sequence",
      group: task.group,
    }))
      next = editJson(next, ["tasks", index, key], value);
    next = editJson(
      next,
      ["tasks", index, "options", "cwd"],
      task.cwd === undefined ? undefined : nativeVariables(task.cwd, "vscode"),
    );
    next = editJson(
      next,
      ["tasks", index, "options", "env"],
      task.env === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(task.env).map(([key, value]) => [
              key,
              nativeVariables(value, "vscode"),
            ]),
          ),
    );
    return editJson(next, ["tasks", index, "oxbit"], task);
  }
  let next = text;
  if (!task) {
    next = editJson(next, ["scripts", name], undefined);
    return editJson(next, ["oxbit", "tasks", name], undefined);
  }
  if (sourceCommand !== undefined || data.scripts?.[name] === undefined) {
    let script: unknown = sourceCommand ?? task.command;
    if (
      kind === "composer" &&
      typeof script === "string" &&
      script.trim().startsWith("[")
    ) {
      try {
        script = JSON.parse(script);
      } catch {
        invalid("Composer script array must be valid JSON");
      }
      if (!Array.isArray(script) || script.some((v) => typeof v !== "string"))
        invalid("Composer script array must contain strings");
    }
    next = editJson(next, ["scripts", name], script);
  }
  const metadata = { ...task };
  // The package manager executes the source script, retaining pre/post scripts and callbacks.
  delete (metadata as Partial<TaskDefinition>).command;
  delete metadata.execution;
  delete metadata.args;
  return editJson(next, ["oxbit", "tasks", name], metadata);
}
export function writeSettings(
  kind: TaskSourceKind,
  text: string,
  worktree: TaskHooks,
  env: Record<string, string>,
) {
  if (["make", "just", "procfile"].includes(kind))
    invalid(
      "This source cannot store lifecycle settings; save an Oxbit configuration first",
    );
  if (kind === "jetbrains") {
    const doc = xml(text);
    let component = Array.from(doc.getElementsByTagName("component")).find(
      (node) => node.getAttribute("name") === "OxbitTasks",
    );
    if (!component) {
      component = doc.createElement("component");
      component.setAttribute("name", "OxbitTasks");
      doc.documentElement!.appendChild(component);
    }
    option(doc, component, "worktree", JSON.stringify(worktree));
    option(doc, component, "env", JSON.stringify(env));
    return new XMLSerializer().serializeToString(doc);
  }
  let next = editJson(
    text,
    kind === "oxbit" ? ["worktree"] : ["oxbit", "worktree"],
    worktree,
  );
  if (kind === "paseo") {
    next = editJson(next, ["worktree", "setup"], worktree.init);
    next = editJson(next, ["worktree", "teardown"], worktree.preteardown);
  }
  return editJson(next, kind === "oxbit" ? ["env"] : ["oxbit", "env"], env);
}
