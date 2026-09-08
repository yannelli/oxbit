import type { Setting } from "../packages/sdk/src/index.js";
import * as fs from "node:fs/promises";
import { desktopConfiguration } from "../packages/host-desktop/src/configuration.js";

// Discover declarations without importing UI modules. This includes independently
// shipped features when they contribute a configuration module to the checkout.
const featureRoot = new URL("../packages/features/", import.meta.url);
const featureSettings: Setting[] = [];
for (const name of (await fs.readdir(featureRoot)).sort()) {
  const source = new URL(`${name}/src/configuration.ts`, featureRoot);
  try { await fs.access(source); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
  const module = await import(source.href);
  for (const [key, value] of Object.entries(module))
    if (key.endsWith("Configuration") && Array.isArray(value)) featureSettings.push(...value);
}
export const builtinSettings = [...featureSettings, ...desktopConfiguration];
type Schema = Record<string, any>;
const string = { type: "string" };
const safeString = { type: "string", pattern: "^[^\\u0000]*$" };
const strings = { type: "array", items: safeString };
const object = (properties: Schema, extra: Schema = {}): Schema => ({ type: "object", properties, additionalProperties: false, ...extra });
const jsonObject = { type: "object", additionalProperties: true };
function settingSchema(setting: Setting): Schema {
  return {
    title: setting.title, ...(setting.description ? { description: setting.description } : {}),
    type: setting.type, default: setting.default,
    // Formatter IDs can be contributed by installed extensions.
    ...(setting.enum ? setting.id === "editor.defaultFormatter" ? { anyOf: [{ enum: setting.enum }, string] } : { enum: setting.enum } : {}),
    ...(setting.min === undefined ? {} : { minimum: setting.min }),
    ...(setting.max === undefined ? {} : { maximum: setting.max }),
  };
}

/** Build from the same declarations registered by each built-in feature. */
export function createSettingsSchema(): Schema {
  const properties = Object.fromEntries(builtinSettings.map(setting => [setting.id, settingSchema(setting)]));
  properties["files.associations"] = {
    ...properties["files.associations"], propertyNames: { minLength: 1, maxLength: 1024 },
    additionalProperties: { type: "string", pattern: "^[\\w+-]+$" },
  };
  properties.languageServers = {
    ...properties.languageServers, propertyNames: { pattern: "^[a-zA-Z0-9._-]+$" },
    additionalProperties: object({
      enabled: { type: "boolean", description: "Enable this language server." },
      selectors: { type: "array", items: object({ language: string, pattern: string, scheme: { const: "file" } }, { minProperties: 1 }) },
      rootMarkers: { ...strings, items: { ...safeString, minLength: 1, pattern: "^(?!/)(?!.*\\\\)(?!.*(?:^|/)\\.\\.(?:/|$))[^\\u0000]+$" } },
      executable: { ...safeString, minLength: 1 }, args: strings,
      env: { type: "object", propertyNames: { pattern: "^[A-Za-z_][A-Za-z0-9_]*$" }, additionalProperties: safeString },
      initializationOptions: { ...jsonObject, description: "Server-specific initialization options. Store license credentials in the runtime credential file." },
      settings: { ...jsonObject, description: "Server-specific configuration; nested objects merge across files." },
      priority: { type: "number" },
    }),
  };
  const languageProperties = Object.fromEntries(Object.keys(properties).map(id => [id, { $ref: "#/properties/" + id }]));
  properties["project.intelligence"] = object({
    enabled: { type: "boolean", default: true, description: "Index project dependencies, imports and related files." },
    exclude: { type: "array", items: { type: "string", maxLength: 1024 }, default: [] },
    maxFiles: { type: "integer", minimum: 1, maximum: 100000, default: 20000 },
    maxFileBytes: { type: "integer", minimum: 1, maximum: 5242880, default: 1048576 },
  }, { title: "Project Intelligence", description: "Partial overrides of project.json intelligence. Objects merge across files." });
  properties["project.schemas"] = object({
    catalog: { type: "boolean", default: true, description: "Discover file schemas through SchemaStore. Bundled Oxbit settings support remains available." },
    download: { type: "boolean", default: true, description: "Allow remote schema downloads; cached and bundled schemas work offline." },
    associations: { type: "array", maxItems: 1000, default: [], items: object({
      url: { type: "string", minLength: 1, description: "Schema URL or workspace file URI." },
      fileMatch: { type: "array", items: { type: "string", maxLength: 1024 } },
      schema: { type: ["object", "boolean"], description: "An inline JSON Schema." },
    }, { anyOf: [{ required: ["url"] }, { required: ["schema"] }] }) },
  }, { title: "JSON Schemas", description: "Partial overrides of project.json schemas. Association arrays replace lower arrays." });
  const languagePattern = "^\\[[^\\[\\]]+\\]$";
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: "https://oxbit.dev/schemas/settings.v1.schema.json",
    title: "Oxbit Settings",
    description: "User, private workspace and repository settings. Literal dotted IDs; objects merge recursively, arrays and scalar values replace. Unrecognized extension settings are preserved. Null is a value, not a reset, and must be valid for its setting.",
    type: "object",
    properties: { $schema: { type: "string", description: "JSON Schema URI. Ignored when merging effective preferences." }, ...properties },
    propertyNames: { anyOf: [{ not: { pattern: "^\\[.*\\]$" } }, { pattern: languagePattern }] },
    patternProperties: { [languagePattern]: { $ref: "#/definitions/languageOverrides" } },
    additionalProperties: true,
    definitions: {
      languageOverrides: object({ ...languageProperties, "project.intelligence": false, "project.schemas": false }, {
        description: "Settings for a language ID, such as [mdx] or [php]. Runtime project options belong at the top level.",
        propertyNames: { not: { pattern: "^\\[.*\\]$" } }, additionalProperties: true,
      }),
    },
  };
}
