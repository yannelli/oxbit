import type { NativeFileHost, WorkspaceFiles } from "./files.js";

export interface SchemaAssociation { url: string; fileMatch: string[] }
/** Mirrors the desktop `json.schemaDownload.enable` and `json.schemaStore.enable` switches. */
export interface SchemaSettings { schemaDownload?: boolean; schemaStore?: boolean }
export const catalogUrl = "https://www.schemastore.org/api/json/catalog.json";
const builtins: SchemaAssociation[] = [
  { url: "https://www.schemastore.org/package.json", fileMatch: ["package.json"] },
  { url: "https://www.schemastore.org/tsconfig.json", fileMatch: ["tsconfig.json", "tsconfig.*.json"] },
  { url: "https://www.schemastore.org/jsconfig.json", fileMatch: ["jsconfig.json"] },
  { url: "https://www.schemastore.org/composer.json", fileMatch: ["composer.json"] },
  { url: "https://www.schemastore.org/github-workflow.json", fileMatch: [".github/workflows/*.yml", ".github/workflows/*.yaml"] },
  { url: "https://www.schemastore.org/compose-spec.json", fileMatch: ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml", "docker-compose.*.yml", "docker-compose.*.yaml", "compose.*.yml", "compose.*.yaml"] },
];

/** JavaScriptCore has no `URL`; this resolves a relative `$ref` against an absolute schema URL. */
export function resolveRemoteReference(relative: string, base: string): string {
  const origin = /^[a-z][a-z\d+.-]*:\/\/[^/?#]*/i.exec(base)?.[0];
  if (!origin) throw new Error("Invalid schema base URI");
  if (relative.startsWith("//")) return origin.split("//")[0] + relative;
  const [path, suffix = ""] = /^([^?#]*)(.*)$/.exec(relative)!.slice(1);
  const directory = base.slice(origin.length).replace(/[?#].*$/, "").replace(/[^/]*$/, "");
  const parts: string[] = [];
  for (const part of (path.startsWith("/") ? path : directory + path).split("/").slice(1)) {
    if (part === "..") parts.pop();
    else if (part !== ".") parts.push(part);
  }
  return origin + "/" + parts.join("/") + suffix;
}

/** Resolves workspace schemas from disk and remote schemas through the host cache. Schemas are JSON data only. */
export class Schemas {
  constructor(private files: WorkspaceFiles, private host: NativeFileHost, public settings: SchemaSettings = {}) {}
  get download() { return this.settings.schemaDownload !== false; }
  content(uri: string): Promise<string> {
    if (uri.startsWith("file:")) {
      const text = this.files.readFile(this.files.path(uri.replace(/#.*$/, "")));
      return text === undefined ? Promise.reject(new Error("JSON schema is unavailable in this workspace")) : Promise.resolve(text);
    }
    if (!/^https?:\/\//i.test(uri)) return Promise.reject(new Error("Unsupported JSON schema URI"));
    const schema = this.host.schema;
    if (!schema) return Promise.reject(new Error("Remote JSON schemas are unavailable"));
    return new Promise((resolve, reject) => schema.call(this.host, uri, this.download, (text, error) => text === null ? reject(new Error(error ?? "JSON schema is unavailable")) : resolve(text)));
  }
  async associations(): Promise<SchemaAssociation[]> {
    if (this.settings.schemaStore === false) return [];
    try {
      const catalog = JSON.parse(await this.content(catalogUrl));
      if (!Array.isArray(catalog.schemas)) throw new Error("Invalid schema catalog");
      return catalog.schemas.filter((item: any) => typeof item?.url === "string" && Array.isArray(item.fileMatch) && item.fileMatch.length && item.fileMatch.every((pattern: unknown) => typeof pattern === "string" && pattern.length <= 1024))
        .slice(0, 10_000).map((item: any) => ({ url: item.url, fileMatch: item.fileMatch }));
    } catch {
      return builtins;
    }
  }
}
