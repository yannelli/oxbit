import { validateJson } from "./language-servers.js";

export type SettingsObject = Record<string, unknown>;
export interface SettingsLayers {
  user: SettingsObject;
  workspace: SettingsObject;
  userLanguages: Record<string, SettingsObject>;
  workspaceLanguages: Record<string, SettingsObject>;
}
export interface SettingsSnapshot {
  layers: SettingsLayers;
  files: { path: string; scope: "user" | "workspace"; exists: boolean; error?: string }[];
}
export interface SettingsChange {
  scope: "user" | "workspace";
  /** Keys are literal JSON keys, including dotted setting IDs and [language] blocks. */
  path: string[];
  before?: unknown;
  /** Omitted for a reset. Null is a value, not a deletion. */
  value?: unknown;
}
export const settingsObject = (value: unknown): value is SettingsObject =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** Recursively merge objects; arrays, null and scalar values replace the lower value. */
export function mergeSettings(lower: unknown, upper: unknown): unknown {
  if (!settingsObject(lower) || !settingsObject(upper)) return structuredClone(upper);
  return Object.fromEntries([...new Set([...Object.keys(lower), ...Object.keys(upper)])].map(key => [
    key, Object.hasOwn(upper, key) ? Object.hasOwn(lower, key) ? mergeSettings(lower[key], upper[key]) : structuredClone(upper[key]) : structuredClone(lower[key]),
  ]));
}
export function parseSettings(value: unknown): SettingsObject {
  validateJson(value);
  if (!settingsObject(value)) throw new Error("Settings must contain a JSON object");
  for (const [key, item] of Object.entries(value))
    if (/^\[.*\]$/.test(key) && (!/^\[[^\[\]]+\]$/.test(key) || !settingsObject(item)))
      throw new Error(`Language settings ${key} must contain an object`);
  return value;
}
export function settingsLayers(user: SettingsObject, workspace: SettingsObject): SettingsLayers {
  const result: SettingsLayers = { user: {}, workspace: {}, userLanguages: {}, workspaceLanguages: {} };
  for (const [scope, value] of [["user", user], ["workspace", workspace]] as const)
    for (const [key, item] of Object.entries(value)) {
      const language = key.match(/^\[([^\]]+)\]$/)?.[1];
      if (language) result[scope === "user" ? "userLanguages" : "workspaceLanguages"][language] = structuredClone(item) as SettingsObject;
      else if (key !== "$schema") result[scope][key] = structuredClone(item);
    }
  return result;
}
export function settingsFile(layers: SettingsLayers, scope: "user" | "workspace"): SettingsObject {
  return { ...structuredClone(layers[scope]), ...Object.fromEntries(Object.entries(layers[scope === "user" ? "userLanguages" : "workspaceLanguages"]).filter(([, value]) => Object.keys(value).length).map(([language, value]) => [`[${language}]`, structuredClone(value)])) };
}
export function settingsChanges(before: SettingsLayers, after: SettingsLayers): SettingsChange[] {
  const result: SettingsChange[] = [];
  const visit = (scope: SettingsChange["scope"], path: string[], a: unknown, b: unknown) => {
    if (JSON.stringify(a) === JSON.stringify(b)) return;
    if (settingsObject(a) && settingsObject(b)) {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) visit(scope, [...path, key], a[key], b[key]);
    } else result.push({ scope, path, ...(a === undefined ? {} : { before: structuredClone(a) }), ...(b === undefined ? {} : { value: structuredClone(b) }) });
  };
  for (const scope of ["user", "workspace"] as const) visit(scope, [], settingsFile(before, scope), settingsFile(after, scope));
  return result;
}
