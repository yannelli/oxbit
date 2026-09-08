import { afterEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { JsonSchemas } from "../src/json-schemas.js";
import { WorkspaceFiles } from "../src/filesystem.js";
import { settingsSchema, SETTINGS_SCHEMA_URI } from "@oxbit/sdk";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function setup(download: typeof fetch) {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "oxbit-schemas-"));
  await fs.mkdir(path.join(directory, "workspace"));
  const service = new JsonSchemas(new WorkspaceFiles(path.join(directory, "workspace")), path.join(directory, "cache"), download);
  cleanup.push(() => fs.rm(directory, { recursive: true, force: true }), () => service.dispose());
  return { service, directory };
}
it("discovers filename schemas, preserves user overrides, and reuses downloads offline", async () => {
  const download = vi.fn(async () => Response.json({ schemas: [{ url: "https://example.com/config.schema.json", fileMatch: ["config.json"] }] }));
  const { service } = await setup(download);
  const options = { catalog: true, download: true, associations: [] };
  const discovered = (await service.settings({}, options)).json.schemas;
  expect(discovered[0].url).toBe("https://example.com/config.schema.json");
  expect(discovered[0].fileMatch).toContain("config.json");
  expect(discovered[1]).toMatchObject({ url: SETTINGS_SCHEMA_URI, schema: settingsSchema });
  const custom = { json: { schemas: [{ fileMatch: ["config.json"], schema: { type: "object" } }] } };
  const settings = await service.settings(custom, options);
  expect(settings.json.schemas[0].fileMatch).toContain("!config.json");
  expect(settings.json.schemas.at(-1)).toEqual(custom.json.schemas[0]);
  expect(download).toHaveBeenCalledTimes(1);
  download.mockImplementation(async () => { throw new Error("Offline"); });
  expect((await service.settings({}, { ...options, download: false })).json.schemas[0].url).toBe("https://example.com/config.schema.json");
  expect(download).toHaveBeenCalledTimes(1);
});
it("bundles settings completion offline, honors explicit overrides, and resolves only its exact local schema path", async () => {
  const download = vi.fn(async () => { throw new Error("Must not download"); });
  const { directory } = await setup(download);
  const schemaFile = path.join(directory, "private/schemas/settings.v1.schema.json");
  const userFile = path.join(directory, "custom-preferences.json");
  const service = new JsonSchemas(new WorkspaceFiles(path.join(directory, "workspace")), path.join(directory, "cache"), download, { schemaFile, settingsPaths: [userFile] });
  cleanup.push(() => service.dispose());
  const options = { catalog: false, download: false, associations: [] };
  const result = await service.settings({}, options);
  expect(result.json.schemas).toHaveLength(1);
  expect(result.json.schemas[0].fileMatch).toContain(pathToFileURL(userFile).href);
  expect(result.json.schemas[0].fileMatch).toContain("**/.config/oxbit/settings.local.json");
  expect(JSON.parse(await service.content(SETTINGS_SCHEMA_URI + "#/definitions/languageOverrides", false))).toEqual(settingsSchema);
  expect(JSON.parse(await service.content(pathToFileURL(schemaFile).href, false))).toEqual(settingsSchema);
  await expect(service.content(pathToFileURL(schemaFile + ".secret").href, false)).rejects.toThrow();
  const custom = { fileMatch: ["**/.config/oxbit/settings.local.json"], schema: { type: "object" } };
  const override = await service.settings({}, { ...options, associations: [custom] });
  expect(override.json.schemas[0].fileMatch).toContain("!**/.config/oxbit/settings.local.json");
  expect(override.json.schemas.at(-1)).toEqual(custom);
  expect(download).not.toHaveBeenCalled();
});
it("coalesces schema requests, preserves relative refs, and can read cached schemas in a new process", async () => {
  const schema = { type: "object", properties: { child: { $ref: "./child.json" } } };
  const download = vi.fn(async () => Response.json(schema));
  const { service, directory } = await setup(download);
  const results = await Promise.all([service.content("https://example.com/schema.json"), service.content("https://example.com/schema.json#/$defs/test")]);
  expect(results.map(text => JSON.parse(text))).toEqual([schema, schema]); expect(download).toHaveBeenCalledTimes(1);
  const offline = new JsonSchemas(new WorkspaceFiles(path.join(directory, "workspace")), service.cache, async () => { throw new Error("Offline"); });
  expect(JSON.parse(await offline.content("https://example.com/schema.json", false))).toEqual(schema);
  await expect(offline.content("https://example.com/missing.json", false)).rejects.toThrow("not cached");
  for (const name of await fs.readdir(service.cache)) {
    const file = path.join(service.cache, name), entry = JSON.parse(await fs.readFile(file, "utf8")); entry.fetchedAt = 0; await fs.writeFile(file, JSON.stringify(entry));
  }
  expect(JSON.parse(await offline.content("https://example.com/schema.json"))).toEqual(schema);
  await offline.dispose();
});
it("bounds local schemas to the workspace and rejects unsafe redirects and invalid JSON", async () => {
  const download = vi.fn(async () => new Response("", { status: 302, headers: { location: "file:///etc/passwd" } }));
  const { service, directory } = await setup(download);
  await fs.writeFile(path.join(directory, "workspace/schema.json"), '{"type":"string"}');
  expect(JSON.parse(await service.content(pathToFileURL(path.join(directory, "workspace/schema.json")).href))).toEqual({ type: "string" });
  await fs.writeFile(path.join(directory, "secret.json"), "{}");
  await expect(service.content(pathToFileURL(path.join(directory, "secret.json")).href)).rejects.toThrow();
  await expect(service.content("https://example.com/redirect.json")).rejects.toThrow("HTTPS");
  download.mockImplementation(async () => new Response("<html>wrong</html>"));
  await expect(service.content("https://example.com/broken.json")).rejects.toThrow();
  expect((await fs.readdir(service.cache).catch(() => [])).length).toBe(0);
});
