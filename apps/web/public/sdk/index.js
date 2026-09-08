// packages/sdk/src/languages.ts
var languages = [
  { id: "typescript", title: "TypeScript", extensions: ["ts", "mts", "cts"], syntax: "typescript", providers: ["typescript"], badge: "TS" },
  { id: "typescriptreact", title: "TypeScript React", extensions: ["tsx"], settingsAliases: ["tsx"], syntax: "tsx", providers: ["typescript"], badge: "TS" },
  { id: "javascript", title: "JavaScript", extensions: ["js", "mjs", "cjs"], syntax: "javascript", providers: ["typescript"], badge: "JS" },
  { id: "javascriptreact", title: "JavaScript React", extensions: ["jsx"], settingsAliases: ["javascript"], syntax: "jsx", providers: ["typescript"], badge: "JS" },
  { id: "markdown", title: "Markdown", extensions: ["md", "markdown"], syntax: "markdown", providers: ["marksman"], badge: "M\u2193" },
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

// packages/sdk/src/settings.schema.json
var settings_schema_default = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "https://oxbit.dev/schemas/settings.v1.schema.json",
  title: "Oxbit Settings",
  description: "User, private workspace and repository settings. Literal dotted IDs; objects merge recursively, arrays and scalar values replace. Unrecognized extension settings are preserved. Null is a value, not a reset, and must be valid for its setting.",
  type: "object",
  properties: {
    $schema: {
      type: "string",
      description: "JSON Schema URI. Ignored when merging effective preferences."
    },
    "workbench.tooltipDelay": {
      title: "Tooltip Delay",
      description: "Delay in milliseconds before showing a tooltip on hover. Keyboard focus shows tooltips immediately.",
      type: "number",
      default: 400,
      minimum: 0,
      maximum: 5e3
    },
    "workbench.colorTheme": {
      title: "Color Theme",
      description: "Specifies the color theme used in the workbench.",
      type: "string",
      default: "Graphite (dark)"
    },
    "workbench.density": {
      title: "Layout Density",
      description: "Controls row heights, padding and label sizes across the workbench.",
      type: "string",
      default: "compact",
      enum: [
        "compact",
        "comfortable"
      ]
    },
    "workbench.sidebarLocation": {
      title: "Sidebar Location",
      description: "Where the primary sidebar is docked.",
      type: "string",
      default: "left",
      enum: [
        "left",
        "right"
      ]
    },
    "editor.fontFamily": {
      title: "Font Family",
      description: "Controls the font family of the editor.",
      type: "string",
      default: "'JetBrains Mono', ui-monospace, monospace"
    },
    "editor.fontSize": {
      title: "Font Size",
      description: "Font size in pixels.",
      type: "number",
      default: 13,
      minimum: 8,
      maximum: 32
    },
    "editor.lineHeight": {
      title: "Line Height",
      description: "Line height in pixels. 0 uses 1.55 \xD7 font size.",
      type: "number",
      default: 20,
      minimum: 0,
      maximum: 60
    },
    "editor.fontLigatures": {
      title: "Font Ligatures",
      description: "Enables font ligatures when the font supports them.",
      type: "boolean",
      default: false
    },
    "editor.tabSize": {
      title: "Tab Size",
      description: "The number of spaces a tab is equal to.",
      type: "number",
      default: 2,
      minimum: 1,
      maximum: 8
    },
    "editor.insertSpaces": {
      title: "Insert Spaces",
      description: "Insert spaces when pressing Tab.",
      type: "boolean",
      default: true
    },
    "editor.detectIndentation": {
      title: "Detect Indentation",
      description: "Detect Tab Size and Insert Spaces from file contents on open.",
      type: "boolean",
      default: true
    },
    "editor.renderIndentGuides": {
      title: "Indentation Guides",
      description: "Render vertical guides for each indent level.",
      type: "boolean",
      default: true
    },
    "editor.wordWrap": {
      title: "Word Wrap",
      description: "Controls how lines should wrap.",
      type: "string",
      default: "off",
      enum: [
        "off",
        "on",
        "bounded"
      ]
    },
    "editor.renderWhitespace": {
      title: "Render Whitespace",
      description: "Controls how the editor renders whitespace characters.",
      type: "string",
      default: "selection",
      enum: [
        "none",
        "boundary",
        "selection",
        "all"
      ]
    },
    "editor.cursorBlinking": {
      title: "Cursor Blinking",
      description: "Cursor animation style.",
      type: "string",
      default: "blink",
      enum: [
        "blink",
        "smooth",
        "phase",
        "solid"
      ]
    },
    "editor.minimap": {
      title: "Minimap",
      description: "Show a minimap of the document.",
      type: "boolean",
      default: false
    },
    "files.autoSave": {
      title: "Auto Save",
      description: "Controls auto save of editors that have unsaved changes.",
      type: "string",
      default: "off",
      enum: [
        "off",
        "afterDelay",
        "onFocusChange",
        "onWindowChange"
      ]
    },
    "files.autoSaveDelay": {
      title: "Auto Save Delay",
      description: "Delay in milliseconds after which an editor is saved automatically. Applies when Auto Save is afterDelay.",
      type: "number",
      default: 1e3,
      minimum: 100,
      maximum: 6e4
    },
    "files.trimTrailingWhitespace": {
      title: "Trim Trailing Whitespace",
      description: "Remove trailing whitespace when saving.",
      type: "boolean",
      default: true
    },
    "editor.formatOnSave": {
      title: "Format On Save",
      description: "Format a file on save. A formatter must be available.",
      type: "boolean",
      default: false
    },
    "editor.defaultFormatter": {
      title: "Default Formatter",
      description: "Formatter used when several are available.",
      type: "string",
      default: "oxbit.prettier",
      anyOf: [
        {
          enum: [
            "oxbit.prettier",
            "oxbit.builtin-ts"
          ]
        },
        {
          type: "string"
        }
      ]
    },
    "terminal.fontSize": {
      title: "Terminal Font Size",
      description: "Font size in pixels for the terminal.",
      type: "number",
      default: 12,
      minimum: 8,
      maximum: 32
    },
    "terminal.scrollback": {
      title: "Scrollback",
      description: "Maximum number of lines kept in the terminal buffer.",
      type: "number",
      default: 5e3,
      minimum: 100,
      maximum: 1e5
    },
    "terminal.confirmOnKill": {
      title: "Confirm On Kill",
      description: "Ask before killing a terminal with a running process.",
      type: "boolean",
      default: true
    },
    "scm.autoFetch": {
      title: "Auto Fetch",
      description: "Periodically fetch from the default remote.",
      type: "boolean",
      default: true
    },
    "scm.diffLayout": {
      title: "Diff Layout",
      description: "Default layout for diff editors.",
      type: "string",
      default: "side-by-side",
      enum: [
        "side-by-side",
        "inline"
      ]
    },
    "files.associations": {
      title: "File Associations",
      description: "Map filename or workspace-relative glob patterns to language IDs. Explicit associations take precedence over built-in detection.",
      type: "object",
      default: {},
      propertyNames: {
        minLength: 1,
        maxLength: 1024
      },
      additionalProperties: {
        type: "string",
        pattern: "^[\\w+-]+$"
      }
    },
    languageServers: {
      title: "Language Servers",
      description: "Configure enabled state, selectors, rootMarkers, executable, args, env, initializationOptions, settings, and priority by server ID. Servers install on first use in a trusted runtime. License keys belong in the runtime-local credential file.",
      type: "object",
      default: {},
      propertyNames: {
        pattern: "^[a-zA-Z0-9._-]+$"
      },
      additionalProperties: {
        type: "object",
        properties: {
          enabled: {
            type: "boolean",
            description: "Enable this language server."
          },
          selectors: {
            type: "array",
            items: {
              type: "object",
              properties: {
                language: {
                  type: "string"
                },
                pattern: {
                  type: "string"
                },
                scheme: {
                  const: "file"
                }
              },
              additionalProperties: false,
              minProperties: 1
            }
          },
          rootMarkers: {
            type: "array",
            items: {
              type: "string",
              pattern: "^(?!/)(?!.*\\\\)(?!.*(?:^|/)\\.\\.(?:/|$))[^\\u0000]+$",
              minLength: 1
            }
          },
          executable: {
            type: "string",
            pattern: "^[^\\u0000]*$",
            minLength: 1
          },
          args: {
            type: "array",
            items: {
              type: "string",
              pattern: "^[^\\u0000]*$"
            }
          },
          env: {
            type: "object",
            propertyNames: {
              pattern: "^[A-Za-z_][A-Za-z0-9_]*$"
            },
            additionalProperties: {
              type: "string",
              pattern: "^[^\\u0000]*$"
            }
          },
          initializationOptions: {
            type: "object",
            additionalProperties: true,
            description: "Server-specific initialization options. Store license credentials in the runtime credential file."
          },
          settings: {
            type: "object",
            additionalProperties: true,
            description: "Server-specific configuration; nested objects merge across files."
          },
          priority: {
            type: "number"
          }
        },
        additionalProperties: false
      }
    },
    "ui.fontFamily": {
      title: "UI Font Family",
      description: "Overrides theme typography. Reset restores the theme value.",
      type: "string",
      default: ""
    },
    "ui.fontSize": {
      title: "UI Font Size",
      description: "Overrides theme typography. Reset restores the theme value.",
      type: "number",
      default: 12,
      minimum: 8,
      maximum: 72
    },
    "ui.fontWeight": {
      title: "UI Font Weight",
      description: "Overrides theme typography. Reset restores the theme value.",
      type: "number",
      default: 400,
      minimum: 100,
      maximum: 900
    },
    "ui.fontStyle": {
      title: "UI Font Style",
      description: "Overrides theme typography. Reset restores the theme value.",
      type: "string",
      default: "normal",
      enum: [
        "normal",
        "italic",
        "oblique"
      ]
    },
    "ui.lineHeight": {
      title: "UI Line Height",
      description: "Overrides theme typography. Reset restores the theme value.",
      type: "number",
      default: 1.4,
      minimum: 1,
      maximum: 3
    },
    "ui.letterSpacing": {
      title: "UI Letter Spacing",
      description: "Overrides theme typography. Reset restores the theme value.",
      type: "number",
      default: 0,
      minimum: -3,
      maximum: 10
    },
    "ui.fontLigatures": {
      title: "UI Font Ligatures",
      description: "Overrides theme typography. Reset restores the theme value.",
      type: "boolean",
      default: false
    },
    "terminal.fontFamily": {
      title: "Terminal Font Family",
      description: "Overrides theme typography. Reset restores the theme value.",
      type: "string",
      default: ""
    },
    "terminal.fontWeight": {
      title: "Terminal Font Weight",
      description: "Overrides theme typography. Reset restores the theme value.",
      type: "number",
      default: 400,
      minimum: 100,
      maximum: 900
    },
    "terminal.fontStyle": {
      title: "Terminal Font Style",
      description: "Overrides theme typography. Reset restores the theme value.",
      type: "string",
      default: "normal",
      enum: [
        "normal",
        "italic",
        "oblique"
      ]
    },
    "terminal.lineHeight": {
      title: "Terminal Line Height",
      description: "Overrides theme typography. Reset restores the theme value.",
      type: "number",
      default: 1,
      minimum: 1,
      maximum: 3
    },
    "terminal.letterSpacing": {
      title: "Terminal Letter Spacing",
      description: "Overrides theme typography. Reset restores the theme value.",
      type: "number",
      default: 0,
      minimum: -3,
      maximum: 10
    },
    "terminal.fontLigatures": {
      title: "Terminal Font Ligatures",
      description: "Overrides theme typography. Reset restores the theme value.",
      type: "boolean",
      default: false
    },
    "workbench.iconTheme": {
      title: "File Icon Theme",
      description: "Select a locally installed icon theme. Unavailable selections use Oxbit defaults until restored.",
      type: "string",
      default: "oxbit.default"
    },
    "workbench.productIconTheme": {
      title: "Product Icon Theme",
      description: "Select a locally installed icon theme. Unavailable selections use Oxbit defaults until restored.",
      type: "string",
      default: "oxbit.default"
    },
    "editor.semanticHighlighting": {
      title: "Semantic Highlighting",
      description: "Color symbols using language server information.",
      type: "boolean",
      default: true
    },
    "editor.inlayHints.types": {
      title: "Type Inlay Hints",
      description: "Show supported type hints in the visible editor.",
      type: "boolean",
      default: true
    },
    "editor.inlayHints.parameters": {
      title: "Parameter Inlay Hints",
      description: "Show supported parameter hints in the visible editor.",
      type: "boolean",
      default: true
    },
    "editor.largeFileIntelligence": {
      title: "Large File Intelligence",
      description: "Allow full semantic highlighting and inlay hints for files larger than 1 MiB.",
      type: "boolean",
      default: false
    },
    "workbench.locale": {
      title: "Display Language",
      type: "string",
      default: "en",
      enum: [
        "en",
        "de"
      ]
    },
    "workbench.reducedMotion": {
      title: "Reduced Motion",
      type: "boolean",
      default: false
    },
    "workbench.keymap": {
      title: "Keymap",
      description: "Keyboard layout applied on top of the Oxbit defaults. User keybindings always win.",
      type: "string",
      default: "default",
      enum: [
        "default",
        "vscode",
        "jetbrains",
        "macos",
        "sublime",
        "atom",
        "visual-studio",
        "emacs"
      ]
    },
    "agentACP.provider": {
      title: "Default agent",
      type: "string",
      default: "codex",
      enum: [
        "codex",
        "cursor",
        "amp"
      ]
    },
    "agentACP.codex.command": {
      title: "Codex ACP executable",
      type: "string",
      default: "npx"
    },
    "agentACP.codex.args": {
      title: "Codex ACP arguments (JSON array)",
      type: "string",
      default: '["-y","@agentclientprotocol/codex-acp@1.10.0"]'
    },
    "agentACP.cursor.command": {
      title: "Cursor ACP executable",
      type: "string",
      default: "agent"
    },
    "agentACP.cursor.args": {
      title: "Cursor ACP arguments (JSON array)",
      type: "string",
      default: '["acp"]'
    },
    "agentACP.amp.command": {
      title: "Amp Agent ACP executable",
      type: "string",
      default: "npx"
    },
    "agentACP.amp.args": {
      title: "Amp Agent ACP arguments (JSON array)",
      type: "string",
      default: '["-y","amp-acp@0.9.0"]'
    },
    "desktop.projects.openBehavior": {
      title: "Open projects",
      type: "string",
      default: "currentWindow",
      enum: [
        "currentWindow",
        "newWindow"
      ]
    },
    "desktop.tools.gitPath": {
      title: "git executable path",
      type: "string",
      default: ""
    },
    "desktop.tools.ghPath": {
      title: "gh executable path",
      type: "string",
      default: ""
    },
    "project.intelligence": {
      type: "object",
      properties: {
        enabled: {
          type: "boolean",
          default: true,
          description: "Index project dependencies, imports and related files."
        },
        exclude: {
          type: "array",
          items: {
            type: "string",
            maxLength: 1024
          },
          default: []
        },
        maxFiles: {
          type: "integer",
          minimum: 1,
          maximum: 1e5,
          default: 2e4
        },
        maxFileBytes: {
          type: "integer",
          minimum: 1,
          maximum: 5242880,
          default: 1048576
        }
      },
      additionalProperties: false,
      title: "Project Intelligence",
      description: "Partial overrides of project.json intelligence. Objects merge across files."
    },
    "project.schemas": {
      type: "object",
      properties: {
        catalog: {
          type: "boolean",
          default: true,
          description: "Discover file schemas through SchemaStore. Bundled Oxbit settings support remains available."
        },
        download: {
          type: "boolean",
          default: true,
          description: "Allow remote schema downloads; cached and bundled schemas work offline."
        },
        associations: {
          type: "array",
          maxItems: 1e3,
          default: [],
          items: {
            type: "object",
            properties: {
              url: {
                type: "string",
                minLength: 1,
                description: "Schema URL or workspace file URI."
              },
              fileMatch: {
                type: "array",
                items: {
                  type: "string",
                  maxLength: 1024
                }
              },
              schema: {
                type: [
                  "object",
                  "boolean"
                ],
                description: "An inline JSON Schema."
              }
            },
            additionalProperties: false,
            anyOf: [
              {
                required: [
                  "url"
                ]
              },
              {
                required: [
                  "schema"
                ]
              }
            ]
          }
        }
      },
      additionalProperties: false,
      title: "JSON Schemas",
      description: "Partial overrides of project.json schemas. Association arrays replace lower arrays."
    }
  },
  propertyNames: {
    anyOf: [
      {
        not: {
          pattern: "^\\[.*\\]$"
        }
      },
      {
        pattern: "^\\[[^\\[\\]]+\\]$"
      }
    ]
  },
  patternProperties: {
    "^\\[[^\\[\\]]+\\]$": {
      $ref: "#/definitions/languageOverrides"
    }
  },
  additionalProperties: true,
  definitions: {
    languageOverrides: {
      type: "object",
      properties: {
        "workbench.tooltipDelay": {
          $ref: "#/properties/workbench.tooltipDelay"
        },
        "workbench.colorTheme": {
          $ref: "#/properties/workbench.colorTheme"
        },
        "workbench.density": {
          $ref: "#/properties/workbench.density"
        },
        "workbench.sidebarLocation": {
          $ref: "#/properties/workbench.sidebarLocation"
        },
        "editor.fontFamily": {
          $ref: "#/properties/editor.fontFamily"
        },
        "editor.fontSize": {
          $ref: "#/properties/editor.fontSize"
        },
        "editor.lineHeight": {
          $ref: "#/properties/editor.lineHeight"
        },
        "editor.fontLigatures": {
          $ref: "#/properties/editor.fontLigatures"
        },
        "editor.tabSize": {
          $ref: "#/properties/editor.tabSize"
        },
        "editor.insertSpaces": {
          $ref: "#/properties/editor.insertSpaces"
        },
        "editor.detectIndentation": {
          $ref: "#/properties/editor.detectIndentation"
        },
        "editor.renderIndentGuides": {
          $ref: "#/properties/editor.renderIndentGuides"
        },
        "editor.wordWrap": {
          $ref: "#/properties/editor.wordWrap"
        },
        "editor.renderWhitespace": {
          $ref: "#/properties/editor.renderWhitespace"
        },
        "editor.cursorBlinking": {
          $ref: "#/properties/editor.cursorBlinking"
        },
        "editor.minimap": {
          $ref: "#/properties/editor.minimap"
        },
        "files.autoSave": {
          $ref: "#/properties/files.autoSave"
        },
        "files.autoSaveDelay": {
          $ref: "#/properties/files.autoSaveDelay"
        },
        "files.trimTrailingWhitespace": {
          $ref: "#/properties/files.trimTrailingWhitespace"
        },
        "editor.formatOnSave": {
          $ref: "#/properties/editor.formatOnSave"
        },
        "editor.defaultFormatter": {
          $ref: "#/properties/editor.defaultFormatter"
        },
        "terminal.fontSize": {
          $ref: "#/properties/terminal.fontSize"
        },
        "terminal.scrollback": {
          $ref: "#/properties/terminal.scrollback"
        },
        "terminal.confirmOnKill": {
          $ref: "#/properties/terminal.confirmOnKill"
        },
        "scm.autoFetch": {
          $ref: "#/properties/scm.autoFetch"
        },
        "scm.diffLayout": {
          $ref: "#/properties/scm.diffLayout"
        },
        "files.associations": {
          $ref: "#/properties/files.associations"
        },
        languageServers: {
          $ref: "#/properties/languageServers"
        },
        "ui.fontFamily": {
          $ref: "#/properties/ui.fontFamily"
        },
        "ui.fontSize": {
          $ref: "#/properties/ui.fontSize"
        },
        "ui.fontWeight": {
          $ref: "#/properties/ui.fontWeight"
        },
        "ui.fontStyle": {
          $ref: "#/properties/ui.fontStyle"
        },
        "ui.lineHeight": {
          $ref: "#/properties/ui.lineHeight"
        },
        "ui.letterSpacing": {
          $ref: "#/properties/ui.letterSpacing"
        },
        "ui.fontLigatures": {
          $ref: "#/properties/ui.fontLigatures"
        },
        "terminal.fontFamily": {
          $ref: "#/properties/terminal.fontFamily"
        },
        "terminal.fontWeight": {
          $ref: "#/properties/terminal.fontWeight"
        },
        "terminal.fontStyle": {
          $ref: "#/properties/terminal.fontStyle"
        },
        "terminal.lineHeight": {
          $ref: "#/properties/terminal.lineHeight"
        },
        "terminal.letterSpacing": {
          $ref: "#/properties/terminal.letterSpacing"
        },
        "terminal.fontLigatures": {
          $ref: "#/properties/terminal.fontLigatures"
        },
        "workbench.iconTheme": {
          $ref: "#/properties/workbench.iconTheme"
        },
        "workbench.productIconTheme": {
          $ref: "#/properties/workbench.productIconTheme"
        },
        "editor.semanticHighlighting": {
          $ref: "#/properties/editor.semanticHighlighting"
        },
        "editor.inlayHints.types": {
          $ref: "#/properties/editor.inlayHints.types"
        },
        "editor.inlayHints.parameters": {
          $ref: "#/properties/editor.inlayHints.parameters"
        },
        "editor.largeFileIntelligence": {
          $ref: "#/properties/editor.largeFileIntelligence"
        },
        "workbench.locale": {
          $ref: "#/properties/workbench.locale"
        },
        "workbench.reducedMotion": {
          $ref: "#/properties/workbench.reducedMotion"
        },
        "workbench.keymap": {
          $ref: "#/properties/workbench.keymap"
        },
        "agentACP.provider": {
          $ref: "#/properties/agentACP.provider"
        },
        "agentACP.codex.command": {
          $ref: "#/properties/agentACP.codex.command"
        },
        "agentACP.codex.args": {
          $ref: "#/properties/agentACP.codex.args"
        },
        "agentACP.cursor.command": {
          $ref: "#/properties/agentACP.cursor.command"
        },
        "agentACP.cursor.args": {
          $ref: "#/properties/agentACP.cursor.args"
        },
        "agentACP.amp.command": {
          $ref: "#/properties/agentACP.amp.command"
        },
        "agentACP.amp.args": {
          $ref: "#/properties/agentACP.amp.args"
        },
        "desktop.projects.openBehavior": {
          $ref: "#/properties/desktop.projects.openBehavior"
        },
        "desktop.tools.gitPath": {
          $ref: "#/properties/desktop.tools.gitPath"
        },
        "desktop.tools.ghPath": {
          $ref: "#/properties/desktop.tools.ghPath"
        },
        "project.intelligence": false,
        "project.schemas": false
      },
      additionalProperties: true,
      description: "Settings for a language ID, such as [mdx] or [php]. Runtime project options belong at the top level.",
      propertyNames: {
        not: {
          pattern: "^\\[.*\\]$"
        }
      }
    }
  }
};

// packages/sdk/src/settings-schema.ts
var settingsSchema = settings_schema_default;
var SETTINGS_SCHEMA_URI = settings_schema_default.$id;

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

// packages/sdk/src/agent-acp.ts
var ACP_PROVIDERS = [
  {
    id: "codex",
    name: "Codex ACP",
    command: "npx",
    args: ["-y", "@agentclientprotocol/codex-acp@1.10.0"],
    setup: "Uses the Codex ACP adapter. Sign in through an advertised authentication method, or use your existing Codex credentials.",
    url: "https://github.com/agentclientprotocol/codex-acp"
  },
  {
    id: "cursor",
    name: "Cursor ACP",
    command: "agent",
    args: ["acp"],
    setup: "Install Cursor CLI and run agent login first. If your executable is cursor-agent, change the command below.",
    url: "https://cursor.com/docs/cli/acp"
  },
  {
    id: "amp",
    name: "Amp Agent ACP",
    command: "npx",
    args: ["-y", "amp-acp@0.9.0"],
    setup: "Uses the community Amp ACP adapter. Install Amp CLI and run amp login first. Set AMP_CLI_PATH in the runtime environment if needed.",
    url: "https://github.com/tao12345666333/amp-acp"
  }
];

// packages/sdk/src/settings.ts
var settingsObject = (value) => !!value && typeof value === "object" && !Array.isArray(value);
function mergeSettings(lower, upper) {
  if (!settingsObject(lower) || !settingsObject(upper)) return structuredClone(upper);
  return Object.fromEntries([.../* @__PURE__ */ new Set([...Object.keys(lower), ...Object.keys(upper)])].map((key) => [
    key,
    Object.hasOwn(upper, key) ? Object.hasOwn(lower, key) ? mergeSettings(lower[key], upper[key]) : structuredClone(upper[key]) : structuredClone(lower[key])
  ]));
}
function parseSettings(value) {
  validateJson(value);
  if (!settingsObject(value)) throw new Error("Settings must contain a JSON object");
  for (const [key, item] of Object.entries(value))
    if (/^\[.*\]$/.test(key) && (!/^\[[^\[\]]+\]$/.test(key) || !settingsObject(item)))
      throw new Error(`Language settings ${key} must contain an object`);
  return value;
}
function settingsLayers(user, workspace) {
  const result = { user: {}, workspace: {}, userLanguages: {}, workspaceLanguages: {} };
  for (const [scope, value] of [["user", user], ["workspace", workspace]])
    for (const [key, item] of Object.entries(value)) {
      const language = key.match(/^\[([^\]]+)\]$/)?.[1];
      if (language) result[scope === "user" ? "userLanguages" : "workspaceLanguages"][language] = structuredClone(item);
      else if (key !== "$schema") result[scope][key] = structuredClone(item);
    }
  return result;
}
function settingsFile(layers, scope) {
  return { ...structuredClone(layers[scope]), ...Object.fromEntries(Object.entries(layers[scope === "user" ? "userLanguages" : "workspaceLanguages"]).filter(([, value]) => Object.keys(value).length).map(([language, value]) => [`[${language}]`, structuredClone(value)])) };
}
function settingsChanges(before, after) {
  const result = [];
  const visit = (scope, path, a, b) => {
    if (JSON.stringify(a) === JSON.stringify(b)) return;
    if (settingsObject(a) && settingsObject(b)) {
      for (const key of /* @__PURE__ */ new Set([...Object.keys(a), ...Object.keys(b)])) visit(scope, [...path, key], a[key], b[key]);
    } else result.push({ scope, path, ...a === void 0 ? {} : { before: structuredClone(a) }, ...b === void 0 ? {} : { value: structuredClone(b) } });
  };
  for (const scope of ["user", "workspace"]) visit(scope, [], settingsFile(before, scope), settingsFile(after, scope));
  return result;
}

// packages/sdk/src/index.ts
var SDK_VERSION = "1.0.0";
export {
  ACP_PROVIDERS,
  SDK_VERSION,
  SETTINGS_SCHEMA_URI,
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
  mergeSettings,
  parseCsv,
  parseSettings,
  registrationMatches,
  resolveLanguage,
  settingsChanges,
  settingsFile,
  settingsLayers,
  settingsObject,
  settingsSchema,
  synchronization,
  textOffset,
  textPosition,
  validateFileAssociations,
  validateJson,
  validateLanguageServers
};
