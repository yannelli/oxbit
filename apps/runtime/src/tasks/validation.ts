import { RpcError } from "@oxbit/protocol";
import {
  taskPhases,
  type TaskDefinition,
  type TaskHooks,
  type TaskPort,
} from "@oxbit/sdk";
export function invalid(message: string): never {
  throw new RpcError("INVALID_TASK_CONFIG", message);
}
export function object(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid(`${label} must be an object`);
  return value as Record<string, any>;
}
export function taskName(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 120 ||
    /[\x00-\x1f\x7f]/.test(value) ||
    ["__proto__", "constructor", "prototype"].includes(value)
  )
    invalid("Task name must contain 1–120 printable characters");
  return value;
}
export function stringMap(
  value: unknown,
  label: string,
): Record<string, string> {
  const record = object(value, label);
  for (const [key, item] of Object.entries(record))
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
      ["__proto__", "constructor", "prototype"].includes(key) ||
      typeof item !== "string" ||
      item.length > 32768 ||
      item.includes("\0")
    )
      invalid(`${label}: invalid environment entry ${key}`);
  return record as Record<string, string>;
}
function number(value: unknown, min: number, max: number, label: string) {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < min ||
    Number(value) > max
  )
    invalid(`${label} must be an integer between ${min} and ${max}`);
}
export function port(value: unknown): TaskPort {
  if (value === "auto") return value;
  if (typeof value === "number") {
    number(value, 1, 65535, "port");
    return value;
  }
  const range = object(value, "port range");
  number(range.min, 1, 65535, "port minimum");
  number(range.max, range.min, 65535, "port maximum");
  return { min: range.min, max: range.max };
}
export function hooks(value: unknown): TaskHooks {
  const data = object(value ?? {}, "worktree");
  for (const key of Object.keys(data))
    if (!taskPhases.includes(key as (typeof taskPhases)[number]))
      invalid(`Unknown worktree phase: ${key}`);
  for (const phase of taskPhases)
    if (data[phase] !== undefined) {
      const lines = Array.isArray(data[phase]) ? data[phase] : [data[phase]];
      if (
        lines.length > 128 ||
        lines.some(
          (line: unknown) =>
            typeof line !== "string" ||
            line.length > 32768 ||
            line.includes("\0"),
        )
      )
        invalid(`worktree.${phase} must be a script or array of scripts`);
    }
  return Object.fromEntries(
    taskPhases
      .filter((phase) => data[phase] !== undefined)
      .map((phase) => [phase, data[phase]]),
  );
}
export function definition(value: unknown): TaskDefinition {
  const data = object(value, "task");
  const known = new Set([
    "command",
    "type",
    "execution",
    "args",
    "cwd",
    "env",
    "dependsOn",
    "dependencyOrder",
    "group",
    "host",
    "hostname",
    "port",
    "ports",
    "ready",
    "restart",
    "stop",
  ]);
  for (const key of Object.keys(data))
    if (!known.has(key)) invalid(`Unknown task field: ${key}`);
  if (
    typeof data.command !== "string" ||
    data.command.length > 32768 ||
    data.command.includes("\0") ||
    (!data.command.trim() && !data.dependsOn?.length)
  )
    invalid("A task needs a command or dependencies");
  for (const [key, choices] of Object.entries({
    type: ["command", "service"],
    execution: ["shell", "process"],
    dependencyOrder: ["sequence", "parallel"],
    group: ["build", "test"],
  }))
    if (data[key] !== undefined && !choices.includes(data[key]))
      invalid(`Invalid ${key}`);
  for (const key of ["args", "dependsOn"])
    if (
      data[key] !== undefined &&
      (!Array.isArray(data[key]) ||
        data[key].length > 128 ||
        data[key].some(
          (v: unknown) =>
            typeof v !== "string" || v.length > 32768 || v.includes("\0"),
        ))
    )
      invalid(`${key} must be an array of strings`);
  for (const key of ["cwd", "host", "hostname"])
    if (
      data[key] !== undefined &&
      (typeof data[key] !== "string" ||
        data[key].length > 4096 ||
        /[\x00-\x1f]/.test(data[key]))
    )
      invalid(`Invalid ${key}`);
  if (data.env !== undefined) stringMap(data.env, "task.env");
  if (data.port !== undefined) port(data.port);
  if (data.ports !== undefined) {
    const entries = Object.entries(object(data.ports, "ports"));
    if (entries.length > 16) invalid("Maximum 16 named ports per task");
    for (const [key, value] of entries) {
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key) || key.toLowerCase() === "port")
        invalid("Port names must be identifiers other than 'port'");
      port(value);
    }
    if (
      new Set(entries.map(([key]) => key.toUpperCase())).size !== entries.length
    )
      invalid("Port names must be unique ignoring case");
  }
  if (data.ready !== undefined) {
    const ready = object(data.ready, "ready");
    for (const key of Object.keys(ready))
      if (!["pattern", "url", "timeoutMs", "intervalMs"].includes(key))
        invalid(`Unknown readiness field: ${key}`);
    if (ready.pattern !== undefined) {
      if (
        typeof ready.pattern !== "string" ||
        !ready.pattern.length ||
        ready.pattern.length > 256
      )
        invalid("ready.pattern must be 1–256 characters");
      // A literal output marker avoids catastrophic regular-expression execution on logs.
    }
    if (
      ready.url !== undefined &&
      (typeof ready.url !== "string" || ready.url.length > 4096)
    )
      invalid("Invalid readiness URL");
    if (ready.timeoutMs !== undefined)
      number(ready.timeoutMs, 100, 3600000, "ready.timeoutMs");
    if (ready.intervalMs !== undefined)
      number(ready.intervalMs, 100, 60000, "ready.intervalMs");
  }
  if (data.restart !== undefined) {
    const restart = object(data.restart, "restart");
    for (const key of Object.keys(restart))
      if (!["policy", "maxAttempts", "delayMs"].includes(key))
        invalid(`Unknown restart field: ${key}`);
    if (!["never", "on-failure"].includes(restart.policy))
      invalid("Invalid restart policy");
    if (restart.maxAttempts !== undefined)
      number(restart.maxAttempts, 0, 10, "restart.maxAttempts");
    if (restart.delayMs !== undefined)
      number(restart.delayMs, 100, 60000, "restart.delayMs");
  }
  if (data.stop !== undefined) {
    const stop = object(data.stop, "stop");
    for (const key of Object.keys(stop))
      if (!["signal", "timeoutMs"].includes(key))
        invalid(`Unknown stop field: ${key}`);
    if (
      stop.signal !== undefined &&
      !["SIGTERM", "SIGINT"].includes(stop.signal)
    )
      invalid("Invalid stop signal");
    if (stop.timeoutMs !== undefined)
      number(stop.timeoutMs, 100, 60000, "stop.timeoutMs");
  }
  return structuredClone(data) as TaskDefinition;
}
export const variableKey = (name: string) =>
  name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
export const shellQuote = (value: string) =>
  `'${value.replaceAll("'", `'"'"'`)}'`;
