import {
  ACP_CUSTOM_PROVIDER,
  acpPreset,
  type ACPConnection,
  type ACPLaunch,
} from "@oxbit/sdk";
import { translate as tr } from "@oxbit/ui";
import { settingId } from "./configuration.js";

/** Splits a command line on spaces. Single or double quotes keep spaces; a backslash escapes the next character. */
export function parseArgs(text: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: string | undefined;
  let started = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === "\\" && quote !== "'" && index + 1 < text.length) {
      current += text[++index];
      started = true;
    } else if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) args.push(current);
      current = "";
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (quote) throw new Error(tr("Close the quote in the agent arguments"));
  if (started) args.push(current);
  return args;
}

export function formatArgs(args: readonly string[]): string {
  return args
    .map((arg) =>
      arg && !/[\s"'\\]/.test(arg)
        ? arg
        : `"${arg.replace(/(["\\])/g, "\\$1")}"`,
    )
    .join(" ");
}

/** Reads a stored JSON array of strings. Returns undefined for missing or invalid values. */
export function storedArgs(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((arg) => typeof arg === "string")
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

const connectionNames = new Map<string, string>();
const registryNames = new Map<string, string>();
export const rememberAgentName = (id: string, name: string | undefined) => {
  if (name) connectionNames.set(id, name);
};
export const rememberRegistryName = (id: string, name: string) =>
  registryNames.set(id, name);

/** Label order: live connection name, preset name, last seen connection name, registry name, then the ID. */
export function agentName(id: string, connection?: Pick<ACPConnection, "provider" | "name">) {
  if (connection?.provider === id && connection.name) return connection.name;
  return (
    acpPreset(id)?.name ??
    connectionNames.get(id) ??
    registryNames.get(id) ??
    id
  );
}

type Configuration = { get<T>(id: string): T | undefined } | undefined;

/** Fills a launch from settings: preset command and args, custom fields, or the registry ID. */
export function resolveLaunch(launch: ACPLaunch, config: Configuration): ACPLaunch {
  const preset = acpPreset(launch.provider);
  if (preset)
    return {
      provider: preset.id,
      command:
        launch.command ||
        config?.get<string>(settingId(preset.id, "command")) ||
        preset.command,
      args:
        launch.args ??
        storedArgs(config?.get<string>(settingId(preset.id, "args"))) ??
        [...preset.args],
    };
  if (launch.provider === ACP_CUSTOM_PROVIDER)
    return {
      provider: ACP_CUSTOM_PROVIDER,
      name:
        launch.name ||
        config?.get<string>(settingId(ACP_CUSTOM_PROVIDER, "name")) ||
        tr("Custom agent"),
      command:
        launch.command ||
        config?.get<string>(settingId(ACP_CUSTOM_PROVIDER, "command")) ||
        "",
      args:
        launch.args ??
        storedArgs(config?.get<string>(settingId(ACP_CUSTOM_PROVIDER, "args"))) ??
        [],
    };
  return {
    provider: launch.provider,
    registry: launch.registry ?? { id: launch.provider },
  };
}

export function launchName(launch: ACPLaunch) {
  return launch.provider === ACP_CUSTOM_PROVIDER && launch.name
    ? launch.name
    : agentName(launch.provider);
}

/** Runtimes before the registry release reject every provider outside their preset list. */
export function runtimeSupportError(error: unknown, name: string) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Choose Codex, Cursor, or Amp")
    ? new Error(
        tr("This runtime does not support {0}. Update Oxbit on the runtime host.", { 0: name }),
      )
    : error;
}
