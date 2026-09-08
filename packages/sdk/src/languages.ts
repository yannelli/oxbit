import type { Kernel, LanguageDefinition } from "./index.js";

export interface LanguagePreset extends LanguageDefinition {
  title: string;
  filenames?: string[];
  patterns?: string[];
  shebangs?: string[];
  syntax: string;
  providers: string[];
  settingsAliases?: string[];
  badge: string;
}

/** Wire IDs are standard LSP IDs. Settings aliases are intentionally separate. */
export const languages: readonly LanguagePreset[] = [
  { id: "typescript", title: "TypeScript", extensions: ["ts", "mts", "cts"], syntax: "typescript", providers: ["typescript"], badge: "TS" },
  { id: "typescriptreact", title: "TypeScript React", extensions: ["tsx"], settingsAliases: ["tsx"], syntax: "tsx", providers: ["typescript"], badge: "TS" },
  { id: "javascript", title: "JavaScript", extensions: ["js", "mjs", "cjs"], syntax: "javascript", providers: ["typescript"], badge: "JS" },
  { id: "javascriptreact", title: "JavaScript React", extensions: ["jsx"], settingsAliases: ["javascript"], syntax: "jsx", providers: ["typescript"], badge: "JS" },
  { id: "markdown", title: "Markdown", extensions: ["md", "markdown"], syntax: "markdown", providers: ["marksman"], badge: "M↓" },
  { id: "mdx", title: "MDX", extensions: ["mdx"], syntax: "mdx", providers: ["mdx"], badge: "MDX" },
  { id: "html", title: "HTML", extensions: ["html", "htm"], syntax: "html", providers: ["html"], badge: "<>" },
  { id: "vue", title: "Vue", extensions: ["vue"], syntax: "vue", providers: ["vue"], badge: "V" },
  { id: "astro", title: "Astro", extensions: ["astro"], syntax: "astro", providers: ["astro"], badge: "A" },
  { id: "dockerfile", title: "Dockerfile", extensions: ["dockerfile"], filenames: ["Dockerfile"], patterns: ["Dockerfile.*"], syntax: "dockerfile", providers: ["dockerfile"], badge: "D" },
  { id: "shellscript", title: "Bash", extensions: ["sh", "bash"], filenames: [".bashrc", ".bash_profile", ".bash_login", ".bash_logout", ".bash_aliases", ".profile"], shebangs: ["bash", "sh"], syntax: "shell", providers: ["bash"], badge: "$" },
  { id: "zsh", title: "Zsh", extensions: ["zsh"], filenames: [".zshrc", ".zshenv", ".zprofile", ".zlogin", ".zlogout"], shebangs: ["zsh"], syntax: "zsh", providers: ["local"], badge: "%" },
  { id: "json", title: "JSON", extensions: ["json"], syntax: "json", providers: ["json"], badge: "{}" },
  { id: "jsonc", title: "JSON with Comments", extensions: ["jsonc"], syntax: "jsonc", providers: ["json"], badge: "{}" },
  { id: "jsonl", title: "JSON Lines", extensions: ["jsonl", "ndjson"], syntax: "jsonl", providers: ["local"], badge: "{}" },
  { id: "toml", title: "TOML", extensions: ["toml"], filenames: ["Cargo.lock"], patterns: ["**/.cargo/config"], syntax: "toml", providers: ["taplo"], badge: "T" },
  { id: "blade", title: "Blade", extensions: ["blade.php"], syntax: "php", providers: ["laravel"], badge: "B" },
  { id: "php", title: "PHP", extensions: ["php", "phtml"], syntax: "php", providers: ["intelephense", "laravel"], badge: "PHP" },
  { id: "xml", title: "XML", extensions: ["xml", "xsd", "xsl", "xslt", "svg"], syntax: "xml", providers: ["lemminx"], badge: "<>" },
  { id: "ini", title: "INI", extensions: ["ini"], syntax: "ini", providers: ["local"], badge: "=" },
  { id: "dotenv", title: "Environment", extensions: ["env"], filenames: [".env"], patterns: [".env.*"], syntax: "dotenv", providers: ["local"], badge: "=" },
  { id: "csv", title: "CSV", extensions: ["csv"], syntax: "csv", providers: ["local"], badge: "▦" },
  { id: "log", title: "Log", extensions: ["log"], syntax: "log", providers: ["local"], badge: "≡" },
  { id: "css", title: "CSS", extensions: ["css"], syntax: "css", providers: [], badge: "#" },
  { id: "plaintext", title: "Plain Text", extensions: ["txt"], syntax: "plaintext", providers: [], badge: "·" },
];

export function canonicalLanguageId(id: string): string {
  return id === "tsx" ? "typescriptreact" : id === "jsx" ? "javascriptreact" : id;
}

/** Small, anchored glob dialect: *, ** and ?. A slash selects workspace-relative paths. */
export function matchesFilePattern(pattern: string, file: string): boolean {
  if (!pattern || pattern.length > 1024) return false;
  const source = pattern.split(/(\*\*\/|\*\*|\*|\?)/).map(part =>
    part === "**/" ? "(?:.*/)?" : part === "**" ? ".*" : part === "*" ? "[^/]*" : part === "?" ? "[^/]" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  ).join("");
  const normalized = file.replaceAll("\\", "/").replace(/^\.\//, "");
  return new RegExp(`^${source}$`).test(pattern.includes("/") ? normalized : normalized.split("/").at(-1)!);
}

export interface LanguageResolutionOptions {
  associations?: Record<string, string>;
  definitions?: readonly LanguageDefinition[];
  firstLine?: string;
}
export function resolveLanguage(file: string, options: LanguageResolutionOptions = {}): LanguageDefinition {
  const definitions = [...(options.definitions ?? []), ...languages];
  for (const [pattern, id] of Object.entries(options.associations ?? {}).reverse()) {
    if (matchesFilePattern(pattern, file)) {
      const canonical = canonicalLanguageId(id);
      return definitions.find(item => item.id === canonical) ?? { id: canonical, extensions: [] };
    }
  }
  const name = file.replaceAll("\\", "/").split("/").at(-1)!;
  const named = definitions.find(item => item.filenames?.includes(name) || item.patterns?.some(pattern => matchesFilePattern(pattern, file)));
  if (named) return named;
  const extension = definitions.find(item => item.extensions.some(ext => name.toLowerCase().endsWith("." + ext.replace(/^\./, "").toLowerCase())));
  if (extension) return extension;
  // Only recognize interpreter names in a shebang. Never execute file contents.
  const interpreter = /^#!\s*(?:\S*\/)?(\w+)(?:\s+(?:-S\s+)?(\w+))?/.exec(options.firstLine ?? "");
  const executable = interpreter?.[1] === "env" ? interpreter[2] : interpreter?.[1];
  return definitions.find(item => executable && item.shebangs?.includes(executable)) ?? languages[languages.length - 1];
}

export function languageForKernel(kernel: Pick<Kernel, "configuration" | "contributions">, file: string, firstLine?: string) {
  return resolveLanguage(file, {
    associations: kernel.configuration.get<Record<string, string>>("files.associations"),
    definitions: kernel.contributions.list("language").map(item => item.data as LanguageDefinition).filter(item => item && typeof item.id === "string" && Array.isArray(item.extensions)),
    firstLine,
  });
}

/** Compatibility API for existing formatter and settings scopes. */
export function languageIdForPath(file: string, options?: LanguageResolutionOptions): string {
  const id = resolveLanguage(file, options).id;
  return languages.find(item => item.id === id)?.settingsAliases?.[0] ?? id;
}
