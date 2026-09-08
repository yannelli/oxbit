import * as fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { settingsSchema, SETTINGS_SCHEMA_URI } from "@oxbit/sdk";
import { WorkspaceFiles } from "./filesystem.js";

export interface SchemaAssociation { url?: string; fileMatch?: string[]; schema?: Record<string, unknown> | boolean }
export interface SchemaOptions { catalog: boolean; download: boolean; associations: SchemaAssociation[] }
const catalogUrl = "https://www.schemastore.org/api/json/catalog.json";
const maxBytes = 5 * 1024 * 1024;
const maxAge = 24 * 60 * 60 * 1000;
const builtins: SchemaAssociation[] = [
  { url: "https://www.schemastore.org/package.json", fileMatch: ["package.json"] },
  { url: "https://www.schemastore.org/tsconfig.json", fileMatch: ["tsconfig.json", "tsconfig.*.json"] },
  { url: "https://www.schemastore.org/jsconfig.json", fileMatch: ["jsconfig.json"] },
  { url: "https://www.schemastore.org/composer.json", fileMatch: ["composer.json"] },
];
type Cached = { url: string; fetchedAt: number; integrity: string; text: string };
interface SettingsSchemaPaths { settingsPaths?: string[]; schemaFile?: string }
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

/** JSON only; downloads never execute code. Original schema URLs remain their base for relative $refs. */
export class JsonSchemas {
  private pending = new Map<string, Promise<string>>();
  private abort = new AbortController();
  private failures = new Map<string, number>();
  constructor(private files: WorkspaceFiles, readonly cache: string, private download: typeof fetch = fetch, private settingsPaths: SettingsSchemaPaths = {}) {}
  private remoteUri(value: string) {
    const uri = new URL(value);
    // Historical SchemaStore and JSON Schema identifiers often use HTTP; fetch them over TLS.
    if (uri.protocol === "http:") uri.protocol = "https:";
    if (uri.protocol !== "https:" || uri.username || uri.password || uri.port && uri.port !== "443") throw new Error("Remote JSON schemas require HTTPS without credentials");
    uri.hash = "";
    return uri.href;
  }
  private async cached(url: string): Promise<Cached | undefined> {
    try {
      const file = path.join(this.cache, digest(url) + ".json");
      if ((await fs.stat(file)).size > maxBytes * 3) return;
      const value = JSON.parse(await fs.readFile(file, "utf8")) as Cached;
      if (value.url === url && typeof value.text === "string" && typeof value.fetchedAt === "number" && value.integrity === digest(value.text)) return value;
    } catch { /* A missing or damaged entry is downloaded again. */ }
  }
  private async fetchJson(url: string) {
    let current = url;
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(8_000)]);
    for (let redirects = 0; redirects < 6; redirects++) {
      const response = await this.download(current, { signal, redirect: "manual", headers: { Accept: "application/schema+json, application/json" } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (!location) throw new Error("Schema redirect has no location");
        current = this.remoteUri(new URL(location, current).href); continue;
      }
      if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`Schema download failed (${response.status})`); }
      if (Number(response.headers.get("content-length")) > maxBytes) { await response.body.cancel(); throw new Error("JSON schema exceeds 5 MiB"); }
      const chunks: Uint8Array[] = []; let length = 0;
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        length += chunk.length;
        if (length > maxBytes) throw new Error("JSON schema exceeds 5 MiB");
        chunks.push(chunk);
      }
      const text = Buffer.concat(chunks).toString("utf8");
      const value = JSON.parse(text);
      if (value === null || typeof value !== "object" && typeof value !== "boolean" || Array.isArray(value)) throw new Error("Invalid JSON schema content");
      return text;
    }
    throw new Error("Too many JSON schema redirects");
  }
  private async remote(value: string, enabled: boolean) {
    const url = this.remoteUri(value), cached = await this.cached(url);
    if (cached && (!enabled || Date.now() - cached.fetchedAt < maxAge)) return cached.text;
    if (!enabled) throw new Error("Schema downloads are disabled and this schema is not cached");
    if ((this.failures.get(url) ?? 0) > Date.now()) {
      if (cached) return cached.text;
      throw new Error("Schema download is temporarily unavailable");
    }
    let pending = this.pending.get(url);
    if (!pending) {
      pending = (async () => {
        try {
          const text = await this.fetchJson(url);
          await fs.mkdir(this.cache, { recursive: true, mode: 0o700 });
          const target = path.join(this.cache, digest(url) + ".json"), temporary = target + "." + randomUUID();
          try {
            await fs.writeFile(temporary, JSON.stringify({ url, fetchedAt: Date.now(), integrity: digest(text), text }), { mode: 0o600 });
            await fs.rename(temporary, target);
          } finally { await fs.rm(temporary, { force: true }); }
          return text;
        } catch (error) {
          this.failures.set(url, Date.now() + 60_000);
          if (cached) return cached.text;
          throw error;
        } finally { this.pending.delete(url); }
      })();
      this.pending.set(url, pending);
    }
    return pending;
  }
  async content(uri: string, enabled = true): Promise<string> {
    if (typeof uri !== "string" || uri.length > 8192) throw new Error("Invalid schema URI");
    const url = new URL(uri);
    url.hash = "";
    if (url.href === SETTINGS_SCHEMA_URI || this.settingsPaths.schemaFile && url.href === pathToFileURL(this.settingsPaths.schemaFile).href) return JSON.stringify(settingsSchema);
    if (url.protocol === "file:") {
      url.hash = "";
      const file = await this.files.resolve(path.relative(this.files.root, fileURLToPath(url)).split(path.sep).join("/"));
      if ((await fs.stat(file)).size > maxBytes) throw new Error("JSON schema exceeds 5 MiB");
      return fs.readFile(file, "utf8");
    }
    return this.remote(uri, enabled);
  }
  async settings(settings: Record<string, any>, options: SchemaOptions): Promise<Record<string, any>> {
    const json = settings.json ?? {}, enabled = options.download && json.schemaDownload?.enable !== false;
    let automatic = builtins;
    if (options.catalog && json.schemaStore?.enable !== false) {
      try {
        const catalog = JSON.parse(await this.remote(catalogUrl, enabled));
        if (!Array.isArray(catalog.schemas)) throw new Error("Invalid schema catalog");
        automatic = catalog.schemas.filter((item: any) => typeof item?.url === "string" && Array.isArray(item.fileMatch) && item.fileMatch.length && item.fileMatch.every((pattern: unknown) => typeof pattern === "string" && pattern.length <= 1024))
          .slice(0, 10_000).map((item: any) => ({ url: item.url, fileMatch: item.fileMatch }));
      } catch { /* Common associations remain available with a cold offline cache. */ }
    } else automatic = [];
    const custom = [...options.associations, ...(Array.isArray(json.schemas) ? json.schemas : [])];
    const oxbit: SchemaAssociation = {
      url: SETTINGS_SCHEMA_URI, schema: settingsSchema,
      fileMatch: ["**/.oxbit/settings.json", "**/.oxbit/projects/*/settings.json", "**/.config/oxbit/settings.json", "**/.config/oxbit/settings.local.json", ...(this.settingsPaths.settingsPaths ?? []).map(file => pathToFileURL(file).href)],
    };
    // Explicit associations take precedence over filename discovery; $schema is handled by the LSP.
    const exclusions = custom.flatMap(item => item.fileMatch ?? []).filter((pattern: string) => !pattern.startsWith("!")).map((pattern: string) => "!" + pattern);
    return { ...settings, json: { validate: { enable: true }, ...json, schemas: [
      ...automatic.map(item => ({ ...item, fileMatch: [...item.fileMatch!, ...oxbit.fileMatch!.map(pattern => "!" + pattern), ...exclusions] })),
      { ...oxbit, fileMatch: [...oxbit.fileMatch!, ...exclusions] }, ...custom,
    ] } };
  }
  async cancelPending() { this.abort.abort(); await Promise.allSettled(this.pending.values()); this.abort = new AbortController(); this.failures.clear(); }
  async dispose() { this.abort.abort(); await Promise.allSettled(this.pending.values()); }
}
