import { validateJson, canonicalLanguageId, languages, languageForKernel, mergeSettings } from "@oxbit/sdk";
import { satisfies, valid, validRange } from "semver";
import {
  SDK_VERSION,
  type Command,
  type ConfigurationService,
  type ContextValues,
  type Contribution,
  type Disposable,
  type Environment,
  type EventMap,
  type Extension,
  type ExtensionContext,
  type ExtensionRecord,
  type Kernel,
  type Persistence,
  type SaveHookContext,
  type Setting,
} from "@oxbit/sdk";

type Listener = () => void;
type Layer = Record<string, unknown>;
interface ConfigurationData {
  user: Layer;
  workspace: Layer;
  userLanguages: Record<string, Layer>;
  workspaceLanguages: Record<string, Layer>;
}
const disposable = (cleanup: () => void): Disposable => {
  let disposed = false;
  return {
    dispose() {
      if (!disposed) {
        disposed = true;
        cleanup();
      }
    },
  };
};
const abortError = () => new DOMException("Operation cancelled", "AbortError");
const notify = (listeners: Set<Listener>) => {
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      console.error(error);
    }
  }
};

function evaluate(expression: string, values: ContextValues): boolean {
  const tokenizer =
    /\s*(===|!==|==|!=|&&|\|\||[!()]|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[\w.$:-]+)/gy;
  const tokens: string[] = [];
  let offset = 0;
  while (offset < expression.trimEnd().length) {
    tokenizer.lastIndex = offset;
    const match = tokenizer.exec(expression);
    if (!match) throw new Error(`Invalid context expression: ${expression}`);
    tokens.push(match[1]!);
    offset = tokenizer.lastIndex;
  }
  let index = 0;
  const atom = (): unknown => {
    const token = tokens[index++];
    if (token === "!") return !atom();
    if (token === "(") {
      const value = or();
      if (tokens[index++] !== ")")
        throw new Error("Unclosed context expression");
      return value;
    }
    if (!token) throw new Error("Missing context operand");
    if (/^['"]/.test(token)) return token.slice(1, -1);
    if (token === "true") return true;
    if (token === "false") return false;
    if (/^\d+$/.test(token)) return Number(token);
    return values[token];
  };
  const equality = (): unknown => {
    const left = atom();
    const op = tokens[index];
    if (["==", "===", "!=", "!=="].includes(op ?? "")) {
      index++;
      const token = tokens[index];
      const right =
        token &&
        /^[\w.$:-]+$/.test(token) &&
        !["true", "false"].includes(token) &&
        !/^\d+$/.test(token)
          ? (index++, token)
          : atom();
      return op === "==" || op === "===" ? left === right : left !== right;
    }
    return left;
  };
  const and = (): boolean => {
    let value = Boolean(equality());
    while (tokens[index] === "&&") {
      index++;
      const right = Boolean(equality());
      value = value && right;
    }
    return value;
  };
  const or = (): boolean => {
    let value = and();
    while (tokens[index] === "||") {
      index++;
      const right = and();
      value = value || right;
    }
    return value;
  };
  const result = or();
  if (index !== tokens.length)
    throw new Error(`Unexpected context token: ${tokens[index]}`);
  return result;
}

export function createKernel({
  environment = "browser",
  persistence,
  additionalExtensionOrigins = [],
}: {
  environment?: Environment;
  persistence?: Persistence;
  additionalExtensionOrigins?: readonly string[];
} = {}): Kernel {
  // URL.origin is "null" for custom schemes in some engines. Compare their
  // normalized scheme and authority so unrelated opaque origins never match.
  const extensionOrigins = new Set(
    additionalExtensionOrigins.map((origin) => {
      const parsed = new URL(origin);
      return `${parsed.protocol}//${parsed.host}`;
    }),
  );
  let batchDepth = 0;
  const pendingNotifications = new Set<Set<Listener>>();
  const publish = (listeners: Set<Listener>) => {
    if (batchDepth) pendingNotifications.add(listeners);
    else notify(listeners);
  };
  const batch = (operation: () => void) => {
    batchDepth++;
    try {
      operation();
    } finally {
      if (--batchDepth === 0) {
        const pending = [...pendingNotifications];
        pendingNotifications.clear();
        for (const listeners of pending) notify(listeners);
      }
    }
  };
  const commands = new Map<string, Command>();
  const commandOwners = new Map<string, string>();
  const declaredCommands = new Map<
    string,
    { owner: string; command: Omit<Command, "run"> }
  >();
  const settingOwners = new Map<string, string>();
  const values: ContextValues = {};
  const contextListeners = new Set<Listener>();
  const settings = new Map<string, Setting>();
  const configListeners = new Set<Listener>();
  const contributionListeners = new Set<Listener>();
  const extensionListeners = new Set<Listener>();
  const contributions = new Map<string, Contribution>();
  const services = new Map<string, unknown>();
  const eventListeners = new Map<keyof EventMap, Set<(value: never) => void>>();
  const hooks = new Map<
    string,
    {
      handler: (ctx: SaveHookContext) => void | string | Promise<void | string>;
      order: number;
    }
  >();
  const saving = new Set<string>();
  const extensions = new Map<
    string,
    {
      extension: Extension;
      record: ExtensionRecord;
      owned: Disposable[];
      installed: Disposable[];
      controller?: AbortController;
      activation?: Promise<void>;
      generation: number;
    }
  >();
  let configurationData: ConfigurationData = {
    user: {},
    workspace: {},
    userLanguages: {},
    workspaceLanguages: {},
  };
  let disposed = false;
  let configurationRevision = 0;
  let configWrite: Promise<void> = Promise.resolve();
  const ensureAlive = () => {
    if (disposed) throw new Error("Kernel is disposed");
  };
  const configChanged = (persist = true) => {
    configurationRevision++;
    publish(configListeners);
    if (persistence && persist) {
      const snapshot = structuredClone(configurationData);
      configWrite = configWrite
        .catch(() => {})
        .then(() => persistence.set("settings", snapshot));
      void configWrite.catch((error) => console.error(error));
    }
  };
  const validate = (id: string, value: unknown) => {
    const setting = settings.get(id);
    if (!setting) throw new Error(`Unknown setting: ${id}`);
    if (
      (setting.type === "array" ? !Array.isArray(value) : setting.type === "object" ? !value || typeof value !== "object" || Array.isArray(value) : typeof value !== setting.type) ||
      (typeof value === "number" && !Number.isFinite(value))
    )
      throw new Error(`${id} requires ${setting.type}`);
    validateJson(value);
    setting.validate?.(value);
    if (setting.enum && !setting.enum.includes(value as string | number))
      throw new Error(`${id} requires one of ${setting.enum.join(", ")}`);
    if (
      typeof value === "number" &&
      ((setting.min !== undefined && value < setting.min) ||
        (setting.max !== undefined && value > setting.max))
    )
      throw new Error(`${id} is outside its allowed range`);
  };
  const layer = (scope: "user" | "workspace", language?: string): Layer => {
    if (!language) return configurationData[scope];
    const languages =
      configurationData[
        scope === "user" ? "userLanguages" : "workspaceLanguages"
      ];
    if (!Object.hasOwn(languages, language))
      Object.defineProperty(languages, language, {
        value: {},
        writable: true,
        enumerable: true,
        configurable: true,
      });
    return languages[language]!;
  };
  const configuration: ConfigurationService = {
    flush: () => configWrite,
    register(setting) {
      ensureAlive();
      if (settings.has(setting.id))
        throw new Error(`Duplicate setting: ${setting.id}`);
      settings.set(setting.id, setting);
      try {
        validate(setting.id, setting.default);
      } catch (error) {
        settings.delete(setting.id);
        throw error;
      }
      publish(configListeners);
      return disposable(() => {
        settings.delete(setting.id);
        settingOwners.delete(setting.id);
        publish(configListeners);
      });
    },
    get<T>(id: string, language?: string): T { return configuration.inspect<T>(id, language).value; },
    inspect<T>(id: string, language?: string) {
      const scopes = language ? [...new Set([language, canonicalLanguageId(language), ...(languages.find(item => item.id === canonicalLanguageId(language))?.settingsAliases ?? [])])] : [];
      const ordered = [
        ...scopes.map(id => configurationData.workspaceLanguages[id]),
        ...scopes.map(id => configurationData.userLanguages[id]),
        configurationData.workspace,
        configurationData.user,
      ];
      let value: unknown = structuredClone(settings.get(id)?.default);
      let origin: { scope?: "workspace" | "user"; language?: string } = {};
      let explicit = false;
      for (const source of ordered.reverse()) {
        if (source && Object.hasOwn(source, id)) {
          try {
            const merged = mergeSettings(value, source[id]);
            validate(id, merged);
            value = merged;
            explicit = true;
            origin = { scope: source === configurationData.workspace || scopes.some(key => source === configurationData.workspaceLanguages[key]) ? "workspace" : "user", language: scopes.find(key => source === configurationData.workspaceLanguages[key] || source === configurationData.userLanguages[key]) };
          } catch {
            /* Invalid persisted values use the next valid layer. */
          }
        }
      }
      return { value: structuredClone(value) as T, explicit, ...origin, defaultValue: structuredClone(settings.get(id)?.default) as T };
    },
    set(id, value, scope = "user", language) {
      validate(id, value);
      layer(scope, language)[id] = structuredClone(value);
      configChanged();
    },
    reset(id, scope = "user", language) {
      delete layer(scope, language)[id];
      configChanged();
    },
    list: () =>
      [...settings.values()].filter(
        (setting) =>
          !settingOwners.has(setting.id) ||
          extensions.get(settingOwners.get(setting.id)!)?.record.state ===
            "active",
      ),
    subscribe(listener) {
      configListeners.add(listener);
      return () => configListeners.delete(listener);
    },
    export: () => structuredClone(configurationData),
    import(data, options) {
      if (!data || typeof data !== "object")
        throw new Error("Invalid settings data");
      const input = data as Partial<ConfigurationData>;
      const record = (value: unknown): Layer =>
        value && typeof value === "object" && !Array.isArray(value)
          ? { ...value }
          : {};
      configurationData = {
        user: record(input.user),
        workspace: record(input.workspace),
        userLanguages: Object.fromEntries(
          Object.entries(record(input.userLanguages)).map(([key, value]) => [
            key,
            record(value),
          ]),
        ),
        workspaceLanguages: Object.fromEntries(
          Object.entries(record(input.workspaceLanguages)).map(
            ([key, value]) => [key, record(value)],
          ),
        ),
      };
      configChanged(options?.persist !== false);
    },
  };
  const extensionChanged = (id: string) => {
    const item = extensions.get(id);
    if (item)
      kernel.events.emit("extension.change", {
        id,
        state: item.record.state,
        ...(item.record.error ? { error: item.record.error } : {}),
      });
    publish(extensionListeners);
    publish(contributionListeners);
    publish(configListeners);
  };
  const release = (owned: Disposable[]) =>
    batch(() => {
      for (const value of owned.splice(0).reverse()) {
        try {
          value.dispose();
        } catch (error) {
          console.error(error);
        }
      }
    });
  const installSchemas = (extension: Extension): Disposable[] => {
    const installed: Disposable[] = [];
    batch(() => {
      try {
        for (const setting of extension.manifest.configuration ?? [])
          installed.push(configuration.register(setting));
        for (const command of extension.manifest.commands ?? []) {
          if (commands.has(command.id) || declaredCommands.has(command.id))
            throw new Error(`Duplicate command: ${command.id}`);
          declaredCommands.set(command.id, {
            owner: extension.manifest.id,
            command,
          });
          installed.push(
            disposable(() => {
              declaredCommands.delete(command.id);
              publish(contributionListeners);
            }),
          );
        }
      } catch (error) {
        release(installed);
        throw error;
      }
    });
    return installed;
  };
  const registerCommand = (command: Command, owner?: string): Disposable => {
    ensureAlive();
    if (
      commands.has(command.id) ||
      (declaredCommands.has(command.id) &&
        declaredCommands.get(command.id)!.owner !== owner)
    )
      throw new Error(`Duplicate command: ${command.id}`);
    commands.set(command.id, command);
    if (owner) commandOwners.set(command.id, owner);
    publish(contributionListeners);
    return disposable(() => {
      commands.delete(command.id);
      commandOwners.delete(command.id);
      publish(contributionListeners);
    });
  };
  const commandFor = (id: string): Command | undefined => {
    const registered = commands.get(id),
      owner = commandOwners.get(id);
    if (
      registered &&
      (!owner || extensions.get(owner)?.record.state === "active")
    )
      return registered;
    const declaration = declaredCommands.get(id);
    const extension = declaration && extensions.get(declaration.owner);
    if (
      declaration &&
      extension?.record.state === "registered" &&
      extension.record.manifest.activation.some(
        (trigger) => trigger === `onCommand:${id}` || trigger === "*",
      )
    )
      return {
        ...declaration.command,
        run: (args) => kernel.commands.execute(id, args),
      };
    return undefined;
  };
  const abortable = <T>(
    operation: Promise<T>,
    signal: AbortSignal,
  ): Promise<T> => {
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const abort = () => reject(abortError());
      signal.addEventListener("abort", abort, { once: true });
      operation
        .then(resolve, reject)
        .finally(() => signal.removeEventListener("abort", abort));
    });
  };
  const checkDependencyGraph = (id: string, chain: string[] = []): void => {
    if (chain.includes(id))
      throw new Error(
        `Extension dependency cycle: ${[...chain, id].join(" -> ")}`,
      );
    const item = extensions.get(id);
    if (!item) throw new Error(`Missing extension: ${id}`);
    for (const dependency of Object.keys(
      item.extension.manifest.dependencies ?? {},
    ))
      checkDependencyGraph(dependency, [...chain, id]);
  };
  const checkManifest = (extension: Extension) => {
    const manifest = extension.manifest;
    if (
      !manifest ||
      typeof manifest.id !== "string" ||
      typeof manifest.name !== "string" ||
      !manifest.name.trim() ||
      typeof manifest.version !== "string" ||
      typeof manifest.sdk !== "string" ||
      manifest.manifestVersion !== 1 ||
      !/^[a-z0-9][a-z0-9._-]+$/i.test(manifest.id) ||
      !valid(manifest.version) ||
      !validRange(manifest.sdk) ||
      !satisfies(SDK_VERSION, manifest.sdk)
    )
      throw new Error(
        `Invalid or incompatible extension manifest: ${manifest?.id ?? "unknown"}`,
      );
    if (
      !Array.isArray(manifest.environments) ||
      !manifest.environments.includes(environment)
    )
      throw new Error(`${manifest.id} does not support ${environment}`);
    if (
      !Array.isArray(manifest.activation) ||
      !Array.isArray(manifest.capabilities) ||
      manifest.activation.some(
        (trigger) =>
          typeof trigger !== "string" || !trigger || trigger.length > 256,
      ) ||
      manifest.environments.some(
        (host) => !["browser", "runtime", "embedded"].includes(host),
      ) ||
      manifest.capabilities.some(
        (value) =>
          ![
            "filesystem.read",
            "filesystem.write",
            "terminal",
            "tasks",
            "git",
            "lsp",
            "collaboration",
            "extensions",
          ].includes(value),
      ) ||
      (manifest.configuration !== undefined &&
        !Array.isArray(manifest.configuration)) ||
      (manifest.commands !== undefined &&
        (!Array.isArray(manifest.commands) ||
          manifest.commands.some(
            (command) =>
              !command ||
              typeof command.id !== "string" ||
              !command.id ||
              typeof command.title !== "string" ||
              !command.title,
          ))) ||
      (manifest.contributions !== undefined &&
        !Array.isArray(manifest.contributions)) ||
      typeof extension.activate !== "function"
    )
      throw new Error(`Invalid extension contract: ${manifest.id}`);
    for (const [id, range] of Object.entries(manifest.dependencies ?? {}))
      if (!validRange(range) || id === manifest.id)
        throw new Error(`Invalid dependency: ${id}`);
  };
  const activate = async (id: string, chain: string[] = []): Promise<void> => {
    ensureAlive();
    if (chain.includes(id))
      throw new Error(
        `Extension dependency cycle: ${[...chain, id].join(" -> ")}`,
      );
    const item = extensions.get(id);
    if (!item) throw new Error(`Missing extension: ${id}`);
    if (item.record.state === "active") return;
    if (item.activation) return item.activation;
    const generation = ++item.generation;
    item.record.state = "activating";
    delete item.record.error;
    item.controller = new AbortController();
    const controller = item.controller;
    const owned: Disposable[] = [];
    item.owned = owned;
    const own = <T extends Disposable>(value: T): T => {
      if (controller.signal.aborted || generation !== item.generation) {
        value.dispose();
        throw abortError();
      }
      if (!owned.includes(value)) owned.push(value);
      return value;
    };
    item.activation = Promise.resolve().then(async () => {
      try {
        checkDependencyGraph(id);
        for (const [dependency, range] of Object.entries(
          item.extension.manifest.dependencies ?? {},
        )) {
          const target = extensions.get(dependency);
          if (!target || !satisfies(target.record.manifest.version, range))
            throw new Error(
              `Missing compatible dependency ${dependency}@${range}`,
            );
          if (target.record.state === "disabled")
            throw new Error(`Dependency is disabled: ${dependency}`);
          await activate(dependency, [...chain, id]);
        }
        if (controller.signal.aborted) throw abortError();
        const context: ExtensionContext = {
          id,
          signal: controller.signal,
          own,
          subscribe: (cleanup) => {
            own(disposable(cleanup));
          },
          commands: {
            ...kernel.commands,
            register: (value) => own(registerCommand(value, id)),
          },
          context: kernel.context,
          configuration: {
            ...kernel.configuration,
            register: (value) => {
              let registration!: Disposable;
              batch(() => {
                registration = kernel.configuration.register(value);
                settingOwners.set(value.id, id);
              });
              return own(registration);
            },
          },
          contributions: {
            ...kernel.contributions,
            register: (value) => own(kernel.contributions.register(value, id)),
            subscribe: (listener) => {
              const cleanup = kernel.contributions.subscribe(listener);
              own(disposable(cleanup));
              return cleanup;
            },
          },
          services: {
            ...kernel.services,
            register: (key, value) => own(kernel.services.register(key, value)),
          },
          events: {
            ...kernel.events,
            on: (event, listener) => own(kernel.events.on(event, listener)),
          },
          hooks: {
            ...kernel.hooks,
            beforeSave: (key, handler, order) =>
              own(
                kernel.hooks.beforeSave(
                  key,
                  (ctx) =>
                    abortable(
                      Promise.resolve().then(() =>
                        handler({
                          ...ctx,
                          signal: AbortSignal.any([
                            ctx.signal,
                            controller.signal,
                          ]),
                        }),
                      ),
                      controller.signal,
                    ),
                  order,
                ),
              ),
          },
        };
        context.context = {
          ...kernel.context,
          subscribe: (listener) => {
            const cleanup = kernel.context.subscribe(listener);
            own(disposable(cleanup));
            return cleanup;
          },
        };
        context.configuration.subscribe = (listener) => {
          const cleanup = kernel.configuration.subscribe(listener);
          own(disposable(cleanup));
          return cleanup;
        };
        for (const contribution of item.extension.manifest.contributions ?? [])
          context.contributions.register(contribution);
        const activation = Promise.resolve(item.extension.activate(context));
        activation.then(
          (result) => {
            if (controller.signal.aborted && result) result.dispose();
          },
          () => {},
        );
        const result = await abortable(activation, controller.signal);
        if (result) own(result);
        if (controller.signal.aborted || generation !== item.generation)
          throw abortError();
        item.record.state = "active";
      } catch (error) {
        controller.abort();
        release(owned);
        if (generation === item.generation) {
          item.record.state = "failed";
          item.record.error =
            error instanceof Error ? error.message : String(error);
        }
        throw error;
      } finally {
        if (generation === item.generation) {
          item.activation = undefined;
          extensionChanged(id);
        }
      }
    });
    extensionChanged(id);
    return item.activation;
  };
  const kernel: Kernel = {
    commands: {
      register: (command) => registerCommand(command),
      async execute(id, args) {
        ensureAlive();
        await kernel.extensions.trigger(`onCommand:${id}`);
        const command = commands.get(id);
        if (!command) throw new Error(`Unknown command: ${id}`);
        const available = kernel.commands.available(id);
        if (!available.enabled) throw new Error(available.reason);
        kernel.events.emit("command.execute", { id });
        return command.run(args);
      },
      list: () =>
        [...new Set([...commands.keys(), ...declaredCommands.keys()])]
          .map(commandFor)
          .filter((command): command is Command => Boolean(command))
          .sort(
            (a, b) =>
              a.title.localeCompare(b.title) || a.id.localeCompare(b.id),
          ),
      available(id) {
        const command = commandFor(id);
        return !command
          ? { enabled: false, reason: "Command is not registered" }
          : !kernel.context.matches(command.when)
            ? { enabled: false, reason: `Requires ${command.when}` }
            : { enabled: true };
      },
      resolveShortcut(key) {
        const normalize = (value: string) =>
          value
            .trim()
            .toLowerCase()
            .split(/\s+/)
            .map((chord) => {
              const keys = chord
                .split("+")
                .map((key) =>
                  ["command", "cmd", "control", "ctrl", "meta"].includes(key)
                    ? "mod"
                    : key,
                );
              return [
                ...["mod", "alt", "shift"].filter((key) => keys.includes(key)),
                ...keys.filter((key) => !["mod", "alt", "shift"].includes(key)),
              ].join("+");
            })
            .join(" ");
        const matches = kernel.commands
          .list()
          .filter(
            (command) =>
              command.shortcut &&
              normalize(command.shortcut) === normalize(key) &&
              kernel.commands.available(command.id).enabled,
          );
        for (const shortcut of kernel.contributions.list("shortcut")) {
          const data = shortcut.data as { key?: string } | string | undefined;
          if (
            shortcut.command &&
            normalize(
              typeof data === "string" ? data : (data?.key ?? shortcut.title),
            ) === normalize(key) &&
            kernel.commands.available(shortcut.command).enabled
          ) {
            const command = commandFor(shortcut.command)!;
            matches.push({
              ...command,
              priority: shortcut.priority ?? command.priority,
              when: shortcut.when ?? command.when,
            });
          }
        }
        return matches.sort(
          (a, b) =>
            (b.priority ?? 0) - (a.priority ?? 0) ||
            (b.when?.length ?? 0) - (a.when?.length ?? 0) ||
            a.id.localeCompare(b.id),
        )[0];
      },
    },
    context: {
      set(key, value) {
        if (values[key] !== value) {
          values[key] = value;
          publish(contextListeners);
          publish(contributionListeners);
        }
      },
      get: (key) => values[key],
      matches(expression) {
        if (!expression) return true;
        try {
          return evaluate(expression, values);
        } catch {
          return false;
        }
      },
      subscribe(listener) {
        contextListeners.add(listener);
        return () => contextListeners.delete(listener);
      },
    },
    configuration,
    contributions: {
      register(value, owner) {
        ensureAlive();
        if (contributions.has(value.id))
          throw new Error(`Duplicate contribution: ${value.id}`);
        contributions.set(value.id, { ...value, owner: owner ?? value.owner });
        publish(contributionListeners);
        return disposable(() => {
          contributions.delete(value.id);
          publish(contributionListeners);
        });
      },
      list(kind) {
        return [...contributions.values()]
          .filter(
            (value) =>
              (!kind || value.kind === kind) &&
              (!value.owner ||
                extensions.get(value.owner)?.record.state === "active") &&
              (["menu", "toolbar"].includes(value.kind) ||
                kernel.context.matches(value.when)),
          )
          .sort(
            (a, b) =>
              (a.order ?? 0) - (b.order ?? 0) ||
              (b.priority ?? 0) - (a.priority ?? 0) ||
              a.id.localeCompare(b.id),
          );
      },
      subscribe(listener) {
        contributionListeners.add(listener);
        return () => contributionListeners.delete(listener);
      },
    },
    services: {
      register(id, value) {
        ensureAlive();
        if (services.has(id)) throw new Error(`Duplicate service: ${id}`);
        services.set(id, value);
        return disposable(() => {
          services.delete(id);
        });
      },
      get<T>(id: string): T {
        if (!services.has(id)) throw new Error(`Missing service: ${id}`);
        return services.get(id) as T;
      },
      optional: <T>(id: string) => services.get(id) as T | undefined,
    },
    events: {
      on(event, listener) {
        ensureAlive();
        const group = eventListeners.get(event) ?? new Set();
        eventListeners.set(event, group);
        group.add(listener as (value: never) => void);
        return disposable(() => {
          group.delete(listener as (value: never) => void);
        });
      },
      emit(event, value) {
        if (event === "document.open") {
          const document = value as EventMap["document.open"];
          void kernel.extensions
            .trigger(`onLanguage:${languageForKernel(kernel, document.path).id}`)
            .catch((error) => console.error(error));
        } else if (
          event === "workspace.change" &&
          (value as EventMap["workspace.change"]).state !== "closed"
        ) {
          const workspace = value as EventMap["workspace.change"];
          void kernel.extensions
            .trigger("onWorkspace")
            .then(() =>
              kernel.extensions.trigger(`onWorkspace:${workspace.id}`),
            )
            .catch((error) => console.error(error));
        }
        for (const listener of eventListeners.get(event) ?? []) {
          try {
            listener(value as never);
          } catch (error) {
            console.error(error);
          }
        }
      },
    },
    hooks: {
      beforeSave(id, handler, order = 0) {
        ensureAlive();
        if (hooks.has(id)) throw new Error(`Duplicate save hook: ${id}`);
        hooks.set(id, { handler, order });
        return disposable(() => {
          hooks.delete(id);
        });
      },
      async runBeforeSave(ctx, timeoutMs = 5000) {
        ensureAlive();
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
          throw new Error("Save-hook deadline must be positive");
        if (saving.has(ctx.documentId))
          throw new Error(`Recursive save blocked: ${ctx.path}`);
        if (ctx.signal.aborted) throw abortError();
        saving.add(ctx.documentId);
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const cancel = () => controller.abort(ctx.signal.reason);
        ctx.signal.addEventListener("abort", cancel, { once: true });
        const deadline = new Promise<never>((_, reject) => {
          const abort = () =>
            reject(
              controller.signal.reason instanceof Error
                ? controller.signal.reason
                : abortError(),
            );
          controller.signal.addEventListener("abort", abort, { once: true });
          timer = setTimeout(
            () =>
              controller.abort(
                new Error(`Save hooks exceeded ${timeoutMs} ms`),
              ),
            timeoutMs,
          );
        });
        try {
          let text = ctx.text;
          for (const [id, hook] of [...hooks].sort(
            ([a, x], [b, y]) => x.order - y.order || a.localeCompare(b),
          )) {
            if (hooks.get(id) !== hook) continue;
            const value = await Promise.race([
              Promise.resolve().then(() => {
                if (controller.signal.aborted) throw abortError();
                return hook.handler({
                  ...ctx,
                  text,
                  signal: controller.signal,
                });
              }),
              deadline,
            ]);
            if (typeof value === "string") text = value;
          }
          return text;
        } finally {
          clearTimeout(timer);
          ctx.signal.removeEventListener("abort", cancel);
          saving.delete(ctx.documentId);
        }
      },
    },
    extensions: {
      register(extension) {
        ensureAlive();
        checkManifest(extension);
        if (extensions.has(extension.manifest.id))
          throw new Error(`Duplicate extension: ${extension.manifest.id}`);
        batch(() => {
          const installed = installSchemas(extension);
          extensions.set(extension.manifest.id, {
            extension,
            record: { manifest: extension.manifest, state: "registered" },
            owned: [],
            installed,
            generation: 0,
          });
          extensionChanged(extension.manifest.id);
        });
      },
      activate: (id) => activate(id),
      async trigger(event) {
        let commandFailure: unknown;
        for (const [id, item] of extensions) {
          const triggers = item.record.manifest.activation;
          if (
            item.record.state !== "registered" ||
            !triggers.some(
              (trigger) =>
                trigger === event ||
                trigger === "*" ||
                (event === "onStartup" && trigger === "onStartupFinished"),
            )
          )
            continue;
          try {
            await activate(id);
          } catch (error) {
            if (event.startsWith("onCommand:") && triggers.includes(event))
              commandFailure ??= error;
          }
        }
        if (commandFailure) throw commandFailure;
      },
      async disable(id) {
        const item = extensions.get(id);
        if (!item) throw new Error(`Missing extension: ${id}`);
        item.generation++;
        item.controller?.abort();
        release(item.owned);
        item.activation = undefined;
        item.record.state = "disabled";
        delete item.record.error;
        for (const [dependencyId, target] of extensions)
          if (
            ["active", "activating"].includes(target.record.state) &&
            target.record.manifest.dependencies?.[id]
          )
            await kernel.extensions.disable(dependencyId);
        extensionChanged(id);
      },
      async remove(id) {
        await kernel.extensions.disable(id);
        batch(() => {
          release(extensions.get(id)!.installed);
          extensions.delete(id);
          publish(extensionListeners);
        });
      },
      async update(extension) {
        checkManifest(extension);
        const id = extension.manifest.id;
        const item = extensions.get(id);
        if (!item) throw new Error(`Missing extension: ${id}`);
        for (const dependent of extensions.values()) {
          const range = dependent.record.manifest.dependencies?.[id];
          if (range && !satisfies(extension.manifest.version, range))
            throw new Error(
              `Update breaks ${dependent.record.manifest.id} dependency ${id}@${range}`,
            );
        }
        const active = [...extensions]
          .filter(([, value]) => value.record.state === "active")
          .map(([key]) => key);
        const previous = item.extension;
        const previousRecord = { ...item.record };
        const wasActive = item.record.state === "active";
        const swapSchemas = (next: Extension) =>
          batch(() => {
            release(item.installed);
            item.installed = installSchemas(next);
          });
        const restoreDependents = async () => {
          for (const key of active)
            if (key !== id && extensions.get(key)?.record.state === "disabled")
              await activate(key);
        };
        await kernel.extensions.disable(id);
        try {
          swapSchemas(extension);
          item.extension = extension;
          item.record = {
            manifest: extension.manifest,
            state: wasActive ? "registered" : previousRecord.state,
          };
          if (wasActive) {
            await activate(id);
            await restoreDependents();
          }
        } catch (error) {
          await kernel.extensions.disable(id);
          swapSchemas(previous);
          item.extension = previous;
          item.record = {
            ...previousRecord,
            state: wasActive ? "registered" : previousRecord.state,
          };
          if (wasActive) {
            await activate(id);
            await restoreDependents();
          }
          throw error;
        }
        extensionChanged(id);
      },
      async load(url, options) {
        const parsed = new URL(url, globalThis.location?.href ?? "file:///");
        if (
          !["http:", "https:", "file:"].includes(parsed.protocol) &&
          (!extensionOrigins.has(`${parsed.protocol}//${parsed.host}`) ||
            parsed.username || parsed.password)
        )
          throw new Error(
            "Extensions require a trusted HTTP(S), file, or application ESM artifact",
          );
        const module = await import(/* @vite-ignore */ parsed.href);
        const extension = (module.default ?? module.extension) as Extension;
        kernel.extensions.register(extension);
        if (options?.activate !== false) await activate(extension.manifest.id);
        return extension.manifest.id;
      },
      list: () => [...extensions.values()].map((item) => ({ ...item.record })),
      subscribe(listener) {
        extensionListeners.add(listener);
        return () => extensionListeners.delete(listener);
      },
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const item of extensions.values()) {
        item.generation++;
        item.controller?.abort();
        release(item.owned);
        release(item.installed);
      }
      commands.clear();
      declaredCommands.clear();
      settings.clear();
      contributions.clear();
      services.clear();
      eventListeners.clear();
      hooks.clear();
      contextListeners.clear();
      configListeners.clear();
      contributionListeners.clear();
      extensionListeners.clear();
    },
  };
  if (persistence)
    void persistence
      .get("settings")
      .then((data) => {
        if (data && !disposed && configurationRevision === 0)
          configuration.import(data, { persist: false });
      })
      .catch((error) => console.error(error));
  return kernel;
}
