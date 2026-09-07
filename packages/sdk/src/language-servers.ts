import type { Json } from "./index.js";
import type { LspRegistration } from "./lsp-capabilities.js";

export interface LanguageSelector { language?: string; pattern?: string; scheme?: "file" }
export interface LanguageServerConfiguration {
  enabled?: boolean;
  selectors?: LanguageSelector[];
  rootMarkers?: string[];
  executable?: string;
  args?: string[];
  env?: Record<string, string>;
  initializationOptions?: Record<string, Json>;
  settings?: Record<string, Json>;
  priority?: number;
}
export type LanguageServerSettings = Record<string, LanguageServerConfiguration>;
/** `ready` is retained by the existing runtime status RPC; the UI labels it Running. */
export type LanguageServerState = "installing" | "starting" | "ready" | "running" | "stopped" | "failed" | "unavailable";
export interface LanguageServerDefinition extends LanguageServerConfiguration {
  id: string;
  name: string;
  selectors: LanguageSelector[];
  rootMarkers: string[];
}
export interface LanguageServerInstallation {
  id: string;
  version: string;
  platform: "darwin-arm64" | "linux-x64";
  directory: string;
  integrity: string;
}
export interface LanguageCapabilitySnapshot {
  generation: number;
  capabilities?: Record<string, unknown>;
  registrations: LspRegistration[];
}
export interface LanguageServerInstance extends LanguageCapabilitySnapshot {
  instanceId: string;
  definitionId: string;
  rootUri: string;
  projectRootUri: string;
  fingerprint: string;
  state: LanguageServerState;
  version?: string;
  error?: string;
}

export function validateJson(value: unknown, seen = new Set<object>(), depth = 0): asserts value is Json {
  if (depth > 64) throw new Error("JSON nesting exceeds 64 levels");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (!value || typeof value !== "object" || seen.has(value)) throw new Error("Settings require finite, acyclic JSON values");
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    throw new Error("Settings require plain JSON objects");
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error("Unsafe settings key");
    validateJson(child, seen, depth + 1);
  }
  seen.delete(value);
}
function object(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object");
}
function strings(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string" || item.includes("\0"))) throw new Error("Expected an array of strings without NUL characters");
}
export function validateFileAssociations(value: unknown) {
  validateJson(value); object(value);
  for (const [pattern, id] of Object.entries(value))
    if (!pattern || pattern.length > 1024 || typeof id !== "string" || !/^[\w+-]+$/.test(id)) throw new Error("File associations map glob patterns to language IDs");
}
export function validateLanguageServers(value: unknown): asserts value is LanguageServerSettings {
  validateJson(value); object(value);
  const keys = ["enabled", "selectors", "rootMarkers", "executable", "args", "env", "initializationOptions", "settings", "priority"];
  for (const [id, config] of Object.entries(value)) {
    if (!/^[a-zA-Z0-9._-]+$/.test(id)) throw new Error("Invalid language server ID");
    object(config);
    for (const key of Object.keys(config)) if (!keys.includes(key)) throw new Error(`Unknown language server option: ${key}`);
    if (config.enabled !== undefined && typeof config.enabled !== "boolean") throw new Error("enabled must be boolean");
    if (config.priority !== undefined && (typeof config.priority !== "number" || !Number.isFinite(config.priority))) throw new Error("priority must be finite");
    if (config.executable !== undefined && (typeof config.executable !== "string" || !config.executable || config.executable.includes("\0"))) throw new Error("executable must be a path or executable name");
    if (config.args !== undefined) strings(config.args);
    if (config.rootMarkers !== undefined) {
      strings(config.rootMarkers);
      if (config.rootMarkers.some(marker => !marker || marker.startsWith("/") || marker.includes("\\") || marker.split("/").includes(".."))) throw new Error("Root markers must stay within the workspace");
    }
    if (config.selectors !== undefined) {
      if (!Array.isArray(config.selectors)) throw new Error("selectors must be an array");
      for (const selector of config.selectors) {
        object(selector);
        if (Object.keys(selector).some(key => !["language", "pattern", "scheme"].includes(key)) || !Object.keys(selector).length || Object.values(selector).some(item => typeof item !== "string") || selector.scheme !== undefined && selector.scheme !== "file") throw new Error("Invalid document selector");
      }
    }
    for (const key of ["env", "settings", "initializationOptions"]) if (config[key] !== undefined) object(config[key]);
    if (config.env && Object.entries(config.env).some(([key, item]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof item !== "string" || item.includes("\0"))) throw new Error("Invalid environment override");
    // License material belongs in the runtime-local credential file, never persisted workspace configuration.
    const credentials = (item: unknown): boolean => Boolean(item && typeof item === "object" && Object.entries(item).some(([key, child]) => /(?:^|[._-])licen[cs]e(?:[._-]?key)?$/i.test(key) || credentials(child)));
    if (credentials(config.initializationOptions) || credentials(config.settings) || credentials(config.env)) throw new Error("Store license credentials in the runtime-local language server credential file");
  }
}
