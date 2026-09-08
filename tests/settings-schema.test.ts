import { expect, it } from "vitest";
import Ajv from "ajv";
import * as fs from "node:fs/promises";
import { settingsSchema, validateLanguageServers, validateFileAssociations } from "../packages/sdk/src/index.js";
import { builtinSettings, createSettingsSchema } from "../scripts/settings-schema.js";

const validate = new Ajv({ allErrors: true, strict: false }).compile(settingsSchema);
it("keeps generated and public schemas synchronized with all built-in settings and their defaults", async () => {
  const generated = createSettingsSchema();
  expect(settingsSchema).toEqual(generated);
  expect(JSON.parse(await fs.readFile("apps/web/public/schemas/settings.v1.schema.json", "utf8"))).toEqual(generated);
  expect(new Set(builtinSettings.map(setting => setting.id)).size).toBe(builtinSettings.length);
  const defaults = Object.fromEntries(builtinSettings.map(setting => [setting.id, setting.default]));
  expect(validate(defaults), JSON.stringify(validate.errors)).toBe(true);
});
it("accepts partial merged overrides, language blocks, extensible formatter IDs and extension settings", () => {
  const value = {
    $schema: "../../schemas/settings.v1.schema.json", "editor.tabSize": 4,
    "[mdx]": { "editor.wordWrap": "on", "files.associations": { "*.template": "mdx" } },
    languageServers: { laravel: { enabled: true, rootMarkers: ["artisan"], selectors: [{ language: "blade", scheme: "file" }], settings: { arbitrary: { nested: null } } } },
    "project.intelligence": { maxFiles: 12000 },
    "project.schemas": { download: false, associations: [{ fileMatch: ["config.json"], schema: false }, { url: "https://example.com/schema.json" }] },
    "editor.defaultFormatter": "extension.formatter", "extension.example": { optional: null, values: [1, "two"] },
  };
  expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
  expect(() => validateLanguageServers(value.languageServers)).not.toThrow();
  expect(() => validateFileAssociations(value["[mdx]"]["files.associations"])).not.toThrow();
});
it.each([
  { "editor.tabSize": "4" }, { "editor.tabSize": 0 }, { "editor.wordWrap": true },
  { "workbench.density": "dense" }, { "[mdx]": [] }, { "[mdx][php]": {} },
  { "[mdx]": { "editor.fontSize": 100 } }, { "[mdx]": { "[php]": {} } },
  { "[mdx]": { "project.schemas": {} } },
  { "files.associations": { "*.mdx": 3 } }, { "languageServers": { json: { enabled: "yes" } } },
  { "languageServers": { json: { enable: true } } }, { "languageServers": { json: { rootMarkers: ["../package.json"] } } },
  { "languageServers": { json: { selectors: [{ scheme: "https" }] } } },
  { "languageServers": { json: { args: [1] } } }, { "languageServers": { json: { env: { "invalid-name": "a" } } } },
  { "project.intelligence": { maxFiles: 100001 } }, { "project.intelligence": { maxFileBytes: 1.5 } },
  { "project.schemas": { download: "false" } }, { "project.schemas": { associations: [{ fileMatch: ["settings.json"] }] } },
  { "editor.tabSize": null },
])("diagnoses invalid settings %j", value => { expect(validate(value)).toBe(false); });
