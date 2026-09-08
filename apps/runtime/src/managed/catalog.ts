import { dependencyRoots } from "./dependencies.js";
import { consoleBootstrap } from "./bootstrap.js";
import { pathToFileURL } from "node:url";
import cargoSchema from "./schemas/cargo.json" with { type: "json" };
import cargoConfigSchema from "./schemas/cargo-config.json" with { type: "json" };
import path from "node:path";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import type { LanguageServerDefinition } from "@oxbit/sdk";
import { ManagedInstaller } from "./install.js";
const js = ["typescript", "typescriptreact", "javascript", "javascriptreact"];
const preset = (id: string, name: string, languages: string[], rootMarkers: string[]): LanguageServerDefinition => ({ id, name, selectors: languages.map(language => ({ language })), rootMarkers, priority: 0 });
export const serverCatalog: readonly LanguageServerDefinition[] = [
  preset("typescript", "TypeScript / JavaScript", js, ["tsconfig.json", "jsconfig.json", "package.json"]),
  preset("marksman", "Marksman", ["markdown"], [".marksman.toml", ".git"]),
  preset("mdx", "MDX", ["mdx"], ["tsconfig.json", "jsconfig.json", "package.json"]),
  preset("html", "HTML", ["html"], ["package.json", ".git"]),
  preset("vue", "Vue", ["vue"], ["tsconfig.json", "jsconfig.json", "package.json"]),
  preset("astro", "Astro", ["astro"], ["astro.config.mjs", "astro.config.ts", "astro.config.js", "package.json"]),
  preset("dockerfile", "Dockerfile", ["dockerfile"], ["compose.yaml", "docker-compose.yml", ".git"]),
  preset("bash", "Bash", ["shellscript"], [".shellcheckrc", ".git"]),
  preset("json", "JSON / JSONC", ["json", "jsonc"], ["package.json", ".git"]),
  preset("taplo", "Taplo", ["toml"], ["taplo.toml", ".taplo.toml", "Cargo.toml", ".git"]),
  preset("intelephense", "Intelephense", ["php"], ["composer.json", ".git"]),
  preset("laravel", "Laravel", ["php", "blade"], ["artisan"]),
  preset("lemminx", "LemMinX", ["xml"], [".lemminx", "pom.xml", ".git"]),
];
export interface LaunchSpec {
  schemaContent?: (uri: string) => Promise<string>;
  settingsSection?: string;
  executable: string;
  args: string[];
  env?: Record<string, string>;
  initializationOptions?: Record<string, any>;
  settings?: Record<string, any>;
  version?: string;
  companion?: LaunchSpec;
  dependencyRoots?: string[];
}
const npmPresets: Record<string, [string, string, string[]?]> = {
  typescript: ["typescript-language-server", "lib/cli.mjs", ["typescript"]],
  html: ["vscode-langservers-extracted", "bin/vscode-html-language-server"],
  json: ["vscode-langservers-extracted", "bin/vscode-json-language-server"],
  vue: ["@vue/language-server", "bin/vue-language-server.js", ["@vue/typescript-plugin", "typescript-language-server", "typescript"]],
  astro: ["@astrojs/language-server", "bin/nodeServer.js", ["typescript"]],
  mdx: ["@mdx-js/language-server", "lib/index.js", ["typescript"]],
  dockerfile: ["dockerfile-language-server-nodejs", "bin/docker-langserver"],
  bash: ["bash-language-server", "out/cli.js"],
  intelephense: ["intelephense", "lib/intelephense.js"],
};
export async function resolveLaunch(id: string, root: string, installer: ManagedInstaller, signal?: AbortSignal): Promise<LaunchSpec> {
  if (id === "laravel") {
    const binary = await installer.native("laravel", signal);
    return { executable: binary.executable, args: [], version: binary.version };
  }
  if (id === "marksman" || id === "taplo") {
    const binary = await installer.native(id, signal);
    const schemaDirectory = path.join(installer.cache, "schemas");
    if (id === "taplo") {
      await fs.mkdir(schemaDirectory, { recursive: true });
      await fs.writeFile(path.join(schemaDirectory, "cargo.json"), JSON.stringify(cargoSchema));
      await fs.writeFile(path.join(schemaDirectory, "cargo-config.json"), JSON.stringify(cargoConfigSchema));
    }
    return { executable: binary.executable, args: id === "marksman" ? ["server"] : ["lsp", "stdio"], version: binary.version,
      ...(id === "marksman" ? { env: { DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: "1", DOTNET_CLI_TELEMETRY_OPTOUT: "1" } } : {}),
      ...(id === "taplo" ? { dependencyRoots: [schemaDirectory], settingsSection: "evenBetterToml", initializationOptions: { cachePath: path.join(installer.cache, "taplo-schemas"), configurationSection: "evenBetterToml" }, settings: { evenBetterToml: { schema: { enabled: true, catalogs: [], associations: {
        "(^|/)Cargo\\.toml$": pathToFileURL(path.join(schemaDirectory, "cargo.json")).href,
        "(^|/)\\.cargo/config(?:\\.toml)?$": pathToFileURL(path.join(schemaDirectory, "cargo-config.json")).href,
      } } } } } : {}),
    };
  }
  if (id === "lemminx") {
    const jar = await installer.native("lemminx", signal), jre = await installer.native("jre", signal);
    return { executable: jre.executable, args: ["-Xmx256m", "-jar", jar.executable], version: jar.version,
      settings: { xml: { telemetry: { enabled: false }, downloadExternalResources: { enabled: false } } } };
  }
  const entry = npmPresets[id];
  if (!entry) throw new Error(`Unknown language server preset: ${id}`);
  const [name, bin, dependencies = []] = entry;
  const installation = await installer.npm(id, [name, ...dependencies], signal);
  const modules = path.join(installation.directory, "node_modules");
  const bootstrap = await consoleBootstrap(installer.cache);
  // A file-URL preload also starts when the workspace package.json is temporarily invalid.
  const spec: LaunchSpec = { executable: process.execPath, args: ["--import", pathToFileURL(bootstrap).href, path.join(modules, name, bin), id === "bash" ? "start" : "--stdio"], version: installation.version };
  if (["typescript", "vue", "astro", "mdx"].includes(id)) {
    let sdk = path.join(modules, "typescript/lib");
    try { sdk = path.dirname(createRequire(path.join(root, "package.json")).resolve("typescript/lib/tsserverlibrary.js")); } catch { /* Bundled SDK is available offline. */ }
    spec.dependencyRoots = [await fs.realpath(sdk)];
    const inlayHints = { includeInlayParameterNameHints: "all", includeInlayParameterNameHintsWhenArgumentMatchesName: false, includeInlayVariableTypeHints: true, includeInlayPropertyDeclarationTypeHints: true, includeInlayFunctionParameterTypeHints: true, includeInlayFunctionLikeReturnTypeHints: true };
    spec.settings = { typescript: { inlayHints }, javascript: { inlayHints } };
    spec.dependencyRoots.push(...await dependencyRoots(root, signal));
    if (id === "typescript") spec.initializationOptions = { tsserver: { path: path.join(sdk, "tsserver.js") }, disableAutomaticTypingAcquisition: true };
    if (id === "astro") spec.initializationOptions = { typescript: { tsdk: sdk } };
    if (id === "mdx") spec.initializationOptions = { typescript: { enabled: true, tsdk: sdk } };
    if (id === "vue") {
      spec.initializationOptions = { typescript: { tsdk: sdk } };
      spec.companion = { settings: spec.settings, executable: process.execPath, args: ["--import", pathToFileURL(bootstrap).href, path.join(modules, "typescript-language-server/lib/cli.mjs"), "--stdio"], initializationOptions: {
        tsserver: { path: path.join(sdk, "tsserver.js") }, disableAutomaticTypingAcquisition: true,
        plugins: [{ name: "@vue/typescript-plugin", location: path.join(modules, "@vue/typescript-plugin"), languages: ["vue"], configNamespace: "typescript" }],
      } };
    }
  }
  if (id === "bash") {
    const shellcheck = await installer.native("shellcheck", signal);
    spec.settings = { bashIde: { shellcheckPath: shellcheck.executable, shfmt: { path: "" } } };
  }
  if (id === "json") spec.settings = { json: { validate: { enable: true }, schemas: [] } };
  if (id === "intelephense") {
    spec.dependencyRoots = [await fs.realpath(path.join(modules, "intelephense/lib/stub"))];
    spec.settings = { intelephense: { telemetry: { enabled: false } } };
    spec.initializationOptions = { storagePath: path.join(installer.cache, "intelephense-storage"), globalStoragePath: path.join(installer.cache, "intelephense-global") };
    // Optional premium key remains runtime-local; never include it in fingerprints, UI, or logs.
    try {
      const credentials = JSON.parse(await fs.readFile(path.join(installer.cache, "credentials.json"), "utf8"));
      if (typeof credentials.intelephense === "string") spec.initializationOptions.licenceKey = credentials.intelephense;
    } catch { /* Free features are the default. */ }
  }
  return spec;
}
