import { readFile, writeFile } from "node:fs/promises";
const entries = JSON.parse(
  await readFile("evidence/dependency-resolution.json", "utf8"),
);
const purposes = {
  react: "React workbench and extension views",
  "react-dom": "Browser rendering",
  typescript: "Project references and TypeScript language service",
  ws: "Authenticated runtime WebSocket server",
  lightningcss: "Production CSS transform",
  "markdown-it": "Markdown parsing",
  htmlparser2: "Rendered HTML parsing",
  i18next: "Locale resources",
  "react-i18next": "React localization binding",
  "node-pty": "Real terminal PTYs",
  "typescript-language-server": "TypeScript/JavaScript LSP provider",
  "vscode-jsonrpc": "LSP transport compatibility target",
  yjs: "Shared text CRDT",
  "y-protocols": "Participant awareness protocol",
  "y-codemirror.next": "CodeMirror collaborative binding and local undo",
  dompurify: "Sanitize rendered Markdown",
  prettier: "Language-specific formatting",
  chokidar: "Runtime file watching",
  semver: "SDK and extension compatibility ranges",
  vite: "Browser and runtime production builds",
  "@vitejs/plugin-react": "React JSX transform",
  vitest: "Unit and real runtime integration tests",
  "@playwright/test":
    "Independent browser sessions and visual/performance evidence",
  eslint: "Static lint checks",
  "typescript-eslint": "TypeScript-aware lint rules",
  tsx: "Development runtime TypeScript execution",
};
const rows = new Map();
for (const project of entries) {
  const manifest = JSON.parse(
    await readFile(project.path + "/package.json", "utf8"),
  );
  for (const group of ["dependencies", "devDependencies"])
    for (const [name, value] of Object.entries(project[group] ?? {})) {
      if (name.startsWith("@oxbit/")) continue;
      const key = name + "@" + value.version;
      let row = rows.get(key);
      if (!row) {
        row = {
          name,
          range: manifest[group]?.[name],
          resolved: value.version,
          used: [],
        };
        rows.set(key, row);
      }
      row.used.push(project.name);
    }
}
const purpose = (name) =>
  purposes[name] ??
  (name.startsWith("@codemirror/lang-")
    ? "CodeMirror syntax mode"
    : name.startsWith("@codemirror/")
      ? "CodeMirror editing, selections, language and search APIs"
      : name.startsWith("@xterm/")
        ? "Terminal rendering and " +
          name.replace("@xterm/addon-", "") +
          " support"
        : name.startsWith("@types/")
          ? "Type declarations"
          : name === "@lezer/highlight"
            ? "Theme-aware syntax highlighting"
            : "Build compatibility");
const output =
  "# Dependency contract\n\nResolution captured from pnpm on Node 24.19.0 / Linux arm64. Exact pins and ranges from the Phase 2 specification are retained for installed packages. Native React Native packages remain deferred. `pnpm-lock.yaml` records transitive resolutions.\n\n| Package | Requested | Resolved | Purpose |\n| --- | --- | --- | --- |\n" +
  [...rows.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(
      (r) => `| ${r.name} | ${r.range} | ${r.resolved} | ${purpose(r.name)} |`,
    )
    .join("\n") +
  "\n\n`node-pty` built from source because the installed release has no Linux arm64 prebuild for this environment. Optional xterm GPU rendering falls back after WebGL context loss. Node process, filesystem, Git and server transport dependencies are confined to apps/runtime. Browser code uses the native WebSocket API.\n";
await writeFile("docs/dependencies.md", output);
