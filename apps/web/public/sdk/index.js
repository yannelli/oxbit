// packages/sdk/src/languages.ts
var languages = [
  { id: "typescript", title: "TypeScript", extensions: ["ts", "mts", "cts"], syntax: "typescript", providers: ["typescript"], badge: "TS" },
  { id: "typescriptreact", title: "TypeScript React", extensions: ["tsx"], settingsAliases: ["tsx"], syntax: "tsx", providers: ["typescript"], badge: "TS" },
  { id: "javascript", title: "JavaScript", extensions: ["js", "mjs", "cjs"], syntax: "javascript", providers: ["typescript"], badge: "JS" },
  { id: "javascriptreact", title: "JavaScript React", extensions: ["jsx"], settingsAliases: ["javascript"], syntax: "jsx", providers: ["typescript"], badge: "JS" },
  { id: "markdown", title: "Markdown", extensions: ["md", "markdown"], syntax: "markdown", providers: ["marksman"], badge: "M\u2193" },
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
  { id: "php", title: "PHP", extensions: ["php", "phtml"], syntax: "php", providers: ["intelephense"], badge: "PHP" },
  { id: "xml", title: "XML", extensions: ["xml", "xsd", "xsl", "xslt", "svg"], syntax: "xml", providers: ["lemminx"], badge: "<>" },
  { id: "ini", title: "INI", extensions: ["ini"], syntax: "ini", providers: ["local"], badge: "=" },
  { id: "dotenv", title: "Environment", extensions: ["env"], filenames: [".env"], patterns: [".env.*"], syntax: "dotenv", providers: ["local"], badge: "=" },
  { id: "csv", title: "CSV", extensions: ["csv"], syntax: "csv", providers: ["local"], badge: "\u25A6" },
  { id: "log", title: "Log", extensions: ["log"], syntax: "log", providers: ["local"], badge: "\u2261" },
  { id: "css", title: "CSS", extensions: ["css"], syntax: "css", providers: [], badge: "#" },
  { id: "plaintext", title: "Plain Text", extensions: ["txt"], syntax: "plaintext", providers: [], badge: "\xB7" }
];
function canonicalLanguageId(id) {
  return id === "tsx" ? "typescriptreact" : id === "jsx" ? "javascriptreact" : id;
}
function matchesFilePattern(pattern, file) {
  if (!pattern || pattern.length > 1024) return false;
  const source = pattern.split(/(\*\*\/|\*\*|\*|\?)/).map(
    (part) => part === "**/" ? "(?:.*/)?" : part === "**" ? ".*" : part === "*" ? "[^/]*" : part === "?" ? "[^/]" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  ).join("");
  const normalized = file.replaceAll("\\", "/").replace(/^\.\//, "");
  return new RegExp(`^${source}$`).test(pattern.includes("/") ? normalized : normalized.split("/").at(-1));
}
function resolveLanguage(file, options = {}) {
  const definitions = [...options.definitions ?? [], ...languages];
  for (const [pattern, id] of Object.entries(options.associations ?? {}).reverse()) {
    if (matchesFilePattern(pattern, file)) {
      const canonical = canonicalLanguageId(id);
      return definitions.find((item) => item.id === canonical) ?? { id: canonical, extensions: [] };
    }
  }
  const name = file.replaceAll("\\", "/").split("/").at(-1);
  const named = definitions.find((item) => item.filenames?.includes(name) || item.patterns?.some((pattern) => matchesFilePattern(pattern, file)));
  if (named) return named;
  const extension = definitions.find((item) => item.extensions.some((ext) => name.toLowerCase().endsWith("." + ext.replace(/^\./, "").toLowerCase())));
  if (extension) return extension;
  const interpreter = /^#!\s*(?:\S*\/)?(\w+)(?:\s+(?:-S\s+)?(\w+))?/.exec(options.firstLine ?? "");
  const executable = interpreter?.[1] === "env" ? interpreter[2] : interpreter?.[1];
  return definitions.find((item) => executable && item.shebangs?.includes(executable)) ?? languages[languages.length - 1];
}
function languageForKernel(kernel, file, firstLine) {
  return resolveLanguage(file, {
    associations: kernel.configuration.get("files.associations"),
    definitions: kernel.contributions.list("language").map((item) => item.data).filter((item) => item && typeof item.id === "string" && Array.isArray(item.extensions)),
    firstLine
  });
}
function languageIdForPath(file, options) {
  const id = resolveLanguage(file, options).id;
  return languages.find((item) => item.id === id)?.settingsAliases?.[0] ?? id;
}

// packages/sdk/src/language-servers.ts
function validateJson(value, seen = /* @__PURE__ */ new Set(), depth = 0) {
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
function object(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object");
}
function strings(value) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.includes("\0"))) throw new Error("Expected an array of strings without NUL characters");
}
function validateFileAssociations(value) {
  validateJson(value);
  object(value);
  for (const [pattern, id] of Object.entries(value))
    if (!pattern || pattern.length > 1024 || typeof id !== "string" || !/^[\w+-]+$/.test(id)) throw new Error("File associations map glob patterns to language IDs");
}
function validateLanguageServers(value) {
  validateJson(value);
  object(value);
  const keys = ["enabled", "selectors", "rootMarkers", "executable", "args", "env", "initializationOptions", "settings", "priority"];
  for (const [id, config] of Object.entries(value)) {
    if (!/^[a-zA-Z0-9._-]+$/.test(id)) throw new Error("Invalid language server ID");
    object(config);
    for (const key of Object.keys(config)) if (!keys.includes(key)) throw new Error(`Unknown language server option: ${key}`);
    if (config.enabled !== void 0 && typeof config.enabled !== "boolean") throw new Error("enabled must be boolean");
    if (config.priority !== void 0 && (typeof config.priority !== "number" || !Number.isFinite(config.priority))) throw new Error("priority must be finite");
    if (config.executable !== void 0 && (typeof config.executable !== "string" || !config.executable || config.executable.includes("\0"))) throw new Error("executable must be a path or executable name");
    if (config.args !== void 0) strings(config.args);
    if (config.rootMarkers !== void 0) {
      strings(config.rootMarkers);
      if (config.rootMarkers.some((marker) => !marker || marker.startsWith("/") || marker.includes("\\") || marker.split("/").includes(".."))) throw new Error("Root markers must stay within the workspace");
    }
    if (config.selectors !== void 0) {
      if (!Array.isArray(config.selectors)) throw new Error("selectors must be an array");
      for (const selector of config.selectors) {
        object(selector);
        if (Object.keys(selector).some((key) => !["language", "pattern", "scheme"].includes(key)) || !Object.keys(selector).length || Object.values(selector).some((item) => typeof item !== "string") || selector.scheme !== void 0 && selector.scheme !== "file") throw new Error("Invalid document selector");
      }
    }
    for (const key of ["env", "settings", "initializationOptions"]) if (config[key] !== void 0) object(config[key]);
    if (config.env && Object.entries(config.env).some(([key, item]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof item !== "string" || item.includes("\0"))) throw new Error("Invalid environment override");
    const credentials = (item) => Boolean(item && typeof item === "object" && Object.entries(item).some(([key, child]) => /(?:^|[._-])licen[cs]e(?:[._-]?key)?$/i.test(key) || credentials(child)));
    if (credentials(config.initializationOptions) || credentials(config.settings) || credentials(config.env)) throw new Error("Store license credentials in the runtime-local language server credential file");
  }
}

// packages/sdk/src/text-positions.ts
function textOffset(text, pos) {
  const lines = text.split("\n");
  if (!Number.isInteger(pos.line) || pos.line < 0 || pos.line >= lines.length) throw new Error("Language server returned an invalid line");
  if (!Number.isInteger(pos.character) || pos.character < 0 || pos.character > lines[pos.line].replace(/\r$/, "").length) throw new Error("Language server returned an invalid column");
  let at = 0;
  for (let line = 0; line < pos.line; line++) at += lines[line].length + 1;
  return at + pos.character;
}
function textPosition(text, at) {
  if (!Number.isInteger(at) || at < 0 || at > text.length) throw new Error("Invalid document offset");
  const lines = text.slice(0, at).split("\n");
  return { line: lines.length - 1, character: lines.at(-1).replace(/\r$/, "").length };
}
function incrementalChange(before, after) {
  let from = 0, oldEnd = before.length, newEnd = after.length;
  while (from < oldEnd && from < newEnd && before[from] === after[from]) from++;
  const boundary = (text, at) => at > 0 && (text[at - 1] === "\r" && text[at] === "\n" || /[\uD800-\uDBFF]/.test(text[at - 1]) && /[\uDC00-\uDFFF]/.test(text[at] ?? ""));
  if (boundary(before, from) || boundary(after, from)) from--;
  while (oldEnd > from && newEnd > from && before[oldEnd - 1] === after[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  if (boundary(before, oldEnd) || boundary(after, newEnd)) {
    oldEnd++;
    newEnd++;
  }
  return { range: { start: textPosition(before, from), end: textPosition(before, oldEnd) }, text: after.slice(from, newEnd) };
}

// packages/sdk/src/csv.ts
function parseCsv(text) {
  const rows = [], errors = [];
  let row = [], at = 0;
  while (at < text.length) {
    const from = at;
    let value = "";
    if (text[at] === '"') {
      at++;
      let closed = false;
      while (at < text.length) {
        if (text[at] !== '"') {
          value += text[at++];
          continue;
        }
        if (text[at + 1] === '"') {
          value += '"';
          at += 2;
          continue;
        }
        at++;
        closed = true;
        break;
      }
      if (!closed) errors.push({ from, to: at, message: "Unterminated quoted field" });
      if (at < text.length && !/[,\r\n]/.test(text[at])) {
        const start = at;
        while (at < text.length && !/[,\r\n]/.test(text[at])) at++;
        errors.push({ from: start, to: at, message: "Unexpected text after closing quote" });
      }
    } else {
      while (at < text.length && !/[,\r\n]/.test(text[at])) {
        if (text[at] === '"') errors.push({ from: at, to: at + 1, message: "Quote inside an unquoted field" });
        value += text[at++];
      }
    }
    row.push({ from, to: at, value, row: rows.length, column: row.length });
    if (text[at] === ",") {
      at++;
      if (at === text.length) row.push({ from: at, to: at, value: "", row: rows.length, column: row.length });
    } else {
      rows.push(row);
      row = [];
      if (text[at] === "\r" && text[at + 1] === "\n") at += 2;
      else if (at < text.length) at++;
    }
  }
  if (row.length) rows.push(row);
  const columns = rows[0]?.length;
  for (const record of rows.slice(1)) if (record.length !== columns) errors.push({ from: record[0].from, to: record.at(-1).to, message: `Expected ${columns} columns; found ${record.length}` });
  return { rows, errors };
}

// packages/sdk/src/lsp-glob.ts
function lspGlobMatches(pattern, file) {
  if (typeof pattern !== "string" || pattern.length > 2048 || file.length > 8192) return false;
  let index = 0, groups = 0;
  const literal = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  function expression(depth = 0) {
    if (depth > 8) throw new Error("Glob nesting limit");
    let result = "";
    while (index < pattern.length) {
      const character = pattern[index++];
      if (depth && (character === "," || character === "}")) {
        index--;
        break;
      }
      if (character === "*") {
        if (pattern[index] === "*") {
          index++;
          if (pattern[index] === "/") {
            index++;
            result += "(?:.*/)?";
          } else result += ".*";
        } else result += "[^/]*";
      } else if (character === "?") result += "[^/]";
      else if (character === "{") {
        if (++groups > 32) throw new Error("Glob alternative limit");
        const choices = [expression(depth + 1)];
        while (pattern[index] === ",") {
          index++;
          choices.push(expression(depth + 1));
        }
        if (pattern[index++] !== "}") throw new Error("Unclosed glob group");
        result += "(?:" + choices.join("|") + ")";
      } else if (character === "[") {
        const end = pattern.indexOf("]", index);
        if (end < 0) throw new Error("Unclosed character class");
        let contents = pattern.slice(index, end);
        index = end + 1;
        const negate = contents[0] === "!";
        if (negate) contents = contents.slice(1);
        if (!contents || /[\\/[]/.test(contents)) throw new Error("Invalid character class");
        result += "(?!/)[" + (negate ? "^" : "") + contents.replace(/\^/g, "\\^") + "]";
      } else if (character === "\\") result += literal(pattern[index++] ?? "\\");
      else result += literal(character);
    }
    return result;
  }
  try {
    return new RegExp("^" + expression() + "$", "u").test(file);
  } catch {
    return false;
  }
}
function lspWatchPattern(glob, rootUri) {
  try {
    const rootUrl = new URL(rootUri);
    if (rootUrl.protocol !== "file:" || rootUrl.host) return;
    const root = decodeURIComponent(rootUrl.pathname).replace(/\/$/, "");
    let pattern, base = root;
    if (typeof glob === "string") pattern = glob;
    else if (glob && typeof glob === "object" && "pattern" in glob && "baseUri" in glob && typeof glob.pattern === "string") {
      pattern = glob.pattern;
      const uri = typeof glob.baseUri === "string" ? glob.baseUri : glob.baseUri?.uri;
      if (!uri) return;
      const url = new URL(uri);
      if (url.protocol !== "file:" || url.host || url.search || url.hash) return;
      base = decodeURIComponent(url.pathname).replace(/\/$/, "");
      if (pattern.startsWith("/")) return;
    } else return;
    if (base !== root && !base.startsWith(root + "/")) return;
    if (pattern.startsWith("/")) {
      if (!pattern.startsWith(root + "/")) return;
      pattern = pattern.slice(root.length + 1);
    }
    if (!pattern || pattern.length > 2048 || pattern.includes("\0") || pattern.split("/").includes("..")) return;
    return (base === root ? "" : base.slice(root.length + 1) + "/") + pattern;
  } catch {
    return;
  }
}

// packages/sdk/src/lsp-capabilities.ts
var lspCapabilityKeys = {
  "textDocument/completion": "completionProvider",
  "textDocument/hover": "hoverProvider",
  "textDocument/signatureHelp": "signatureHelpProvider",
  "textDocument/definition": "definitionProvider",
  "textDocument/declaration": "declarationProvider",
  "textDocument/typeDefinition": "typeDefinitionProvider",
  "textDocument/implementation": "implementationProvider",
  "textDocument/references": "referencesProvider",
  "textDocument/rename": "renameProvider",
  "textDocument/codeAction": "codeActionProvider",
  "textDocument/documentSymbol": "documentSymbolProvider",
  "textDocument/formatting": "documentFormattingProvider",
  "workspace/executeCommand": "executeCommandProvider",
  "workspace/symbol": "workspaceSymbolProvider",
  "textDocument/documentHighlight": "documentHighlightProvider",
  "textDocument/documentLink": "documentLinkProvider",
  "textDocument/prepareCallHierarchy": "callHierarchyProvider",
  "textDocument/prepareTypeHierarchy": "typeHierarchyProvider",
  "textDocument/semanticTokens": "semanticTokensProvider",
  "textDocument/inlayHint": "inlayHintProvider"
};
function registrationMatches(selector, document) {
  if (selector === void 0 || selector === null) return true;
  if (!document || !Array.isArray(selector)) return false;
  return selector.some((item) => item && (!item.scheme || item.scheme === "file") && (!item.language || item.language === "*" || canonicalLanguageId(item.language) === canonicalLanguageId(document.language)) && (!item.pattern || typeof item.pattern === "string" && lspGlobMatches(item.pattern, document.path)));
}
function effectiveCapabilities(base, registrations, document) {
  const result = { ...base };
  for (const registration of registrations) {
    const key = lspCapabilityKeys[registration.method];
    if (!registrationMatches(registration.registerOptions?.documentSelector, document)) continue;
    if (key) result[key] = registration.registerOptions ?? true;
    const sync = { ...synchronization(result) };
    if (registration.method === "textDocument/didOpen" || registration.method === "textDocument/didClose") sync.openClose = true;
    else if (registration.method === "textDocument/didChange") sync.change = registration.registerOptions?.syncKind ?? 0;
    else if (registration.method === "textDocument/didSave") sync.save = registration.registerOptions ?? true;
    else if (registration.method === "textDocument/willSave") sync.willSave = true;
    else if (registration.method === "textDocument/willSaveWaitUntil") sync.willSaveWaitUntil = true;
    else continue;
    result.textDocumentSync = sync;
  }
  return result;
}
function synchronization(capabilities) {
  const sync = capabilities.textDocumentSync;
  return typeof sync === "number" ? { openClose: true, change: sync } : sync ?? { openClose: false, change: 0 };
}

// packages/sdk/src/tasks.ts
var taskPhases = [
  "preinit",
  "init",
  "preteardown",
  "teardown"
];

// packages/sdk/src/index.ts
var SDK_VERSION = "1.0.0";
export {
  SDK_VERSION,
  canonicalLanguageId,
  effectiveCapabilities,
  incrementalChange,
  languageForKernel,
  languageIdForPath,
  languages,
  lspCapabilityKeys,
  lspGlobMatches,
  lspWatchPattern,
  matchesFilePattern,
  parseCsv,
  registrationMatches,
  resolveLanguage,
  synchronization,
  taskPhases,
  textOffset,
  textPosition,
  validateFileAssociations,
  validateJson,
  validateLanguageServers
};
