import { mkdirSync, writeFileSync, existsSync } from "node:fs";
const common = { "@oxbit/sdk": "workspace:*" };
const react = { react: "19.1.0", "react-dom": "19.1.0" };
const cm = {
  "@codemirror/commands": "6.10.4",
  "@codemirror/language": "6.12.4",
  "@codemirror/search": "6.7.1",
  "@codemirror/state": "6.7.1",
  "@codemirror/view": "6.43.6",
  "@codemirror/autocomplete": "^6.18.7",
  "@codemirror/lint": "^6.8.5",
};
const xterm = {
  "@xterm/xterm": "^6.1.0-beta.213",
  "@xterm/addon-clipboard": "^0.3.0-beta.213",
  "@xterm/addon-fit": "^0.12.0-beta.213",
  "@xterm/addon-image": "^0.10.0-beta.213",
  "@xterm/addon-ligatures": "^0.11.0-beta.213",
  "@xterm/addon-search": "^0.17.0-beta.213",
  "@xterm/addon-unicode11": "^0.10.0-beta.213",
  "@xterm/addon-web-links": "^0.13.0-beta.213",
  "@xterm/addon-webgl": "^0.20.0-beta.212",
};
const entries = {
  "packages/sdk": ["sdk", react],
  "packages/protocol": ["protocol", {}],
  "packages/core": ["core", { ...common, semver: "^7.7.2" }],
  "packages/documents": [
    "documents",
    { ...common, yjs: "^13.6.27", "y-protocols": "^1.0.6" },
  ],
  "packages/host-browser": ["host-browser", common],
  "packages/host-runtime": [
    "host-runtime",
    { ...common, "@oxbit/protocol": "workspace:*" },
  ],
  "packages/ui": ["ui", { ...common, ...react }],
  "packages/workbench": [
    "workbench",
    {
      ...common,
      ...react,
      ...cm,
      "@oxbit/core": "workspace:*",
      "@oxbit/documents": "workspace:*",
      "@oxbit/ui": "workspace:*",
      "@oxbit/host-browser": "workspace:*",
      "@oxbit/host-runtime": "workspace:*",
      i18next: "^26.3.0",
      "react-i18next": "^17.0.8",
    },
  ],
  "examples/bundle-inspector": ["bundle-inspector", { ...common, ...react }],
  "apps/runtime": [
    "runtime",
    {
      ...common,
      "@oxbit/core": "workspace:*",
      "@oxbit/protocol": "workspace:*",
      ws: "^8.20.0",
      "node-pty": "^1.1.0",
      "typescript-language-server": "^5.0.0",
      "vscode-jsonrpc": "^8.2.1",
      yjs: "^13.6.27",
      "y-protocols": "^1.0.6",
      chokidar: "^4.0.3",
      typescript: "^5.9.3",
    },
  ],
};
const features = [
  "editor",
  "explorer",
  "settings",
  "extensions",
  "themes",
  "language",
  "search",
  "previews",
  "formatters",
  "terminal",
  "tasks",
  "git",
  "collaboration",
];
for (const name of features) {
  let d = {
    ...common,
    ...react,
    "@oxbit/documents": "workspace:*",
    "@oxbit/ui": "workspace:*",
  };
  if (name === "editor")
    Object.assign(d, cm, {
      "@codemirror/lang-javascript": "^6.2.4",
      "@codemirror/lang-json": "^6.0.2",
      "@codemirror/lang-html": "^6.4.9",
      "@codemirror/lang-css": "^6.3.1",
      "@codemirror/lang-markdown": "^6.3.4",
      "@lezer/highlight": "^1.2.1",
      "y-codemirror.next": "^0.3.5",
    });
  if (name === "language") Object.assign(d, cm);
  if (name === "previews")
    Object.assign(d, {
      "markdown-it": "^10.0.0",
      htmlparser2: "^12.0.0",
      dompurify: "^3.2.7",
    });
  if (name === "formatters")
    Object.assign(d, { prettier: "^3.6.2", typescript: "^5.9.3" });
  if (name === "terminal") Object.assign(d, xterm);
  if (name === "collaboration")
    Object.assign(d, { yjs: "^13.6.27", "y-protocols": "^1.0.6" });
  entries["packages/features/" + name] = ["feature-" + name, d];
}
for (const name of ["editor", "explorer", "settings", "extensions"])
  entries["packages/features/" + name][1]["@oxbit/workbench"] = "workspace:*";
entries["apps/web"] = [
  "web",
  {
    ...common,
    ...react,
    "@oxbit/core": "workspace:*",
    "@oxbit/documents": "workspace:*",
    "@oxbit/ui": "workspace:*",
    "@oxbit/workbench": "workspace:*",
    "@oxbit/host-browser": "workspace:*",
    "@oxbit/host-runtime": "workspace:*",
    "@oxbit/bundle-inspector": "workspace:*",
    ...Object.fromEntries(
      features.map((n) => ["@oxbit/feature-" + n, "workspace:*"]),
    ),
    i18next: "^26.3.0",
    "react-i18next": "^17.0.8",
  },
];
for (const [path, [name, dependencies]] of Object.entries(entries)) {
  mkdirSync(path + "/src", { recursive: true });
  const entry = existsSync(path + "/src/index.tsx")
    ? "./src/index.tsx"
    : "./src/index.ts";
  const scripts =
    name === "web"
      ? { dev: "vite --host 0.0.0.0", build: "vite build" }
      : name === "runtime"
        ? {
            dev: "tsx watch src/index.ts",
            start: "node dist/index.js",
            build: "vite build",
          }
        : {};
  writeFileSync(
    path + "/package.json",
    JSON.stringify(
      {
        name: "@oxbit/" + name,
        version: "1.0.0",
        license: "MIT",
        author: {
          name: "Ryan Yannelli",
          email: "ryanyannelli@gmail.com",
          url: "https://github.com/yannelli",
        },
        private: !["sdk", "bundle-inspector"].includes(name),
        type: "module",
        exports:
          name === "ui"
            ? {
                ".": entry,
                "./tokens.css": "./src/tokens.css",
                "./workbench.css": "./src/workbench.css",
              }
            : entry,
        scripts,
        dependencies,
      },
      null,
      2,
    ) + "\n",
  );
  const refs = Object.keys(dependencies)
    .filter((d) => d.startsWith("@oxbit/"))
    .map((d) => Object.keys(entries).find((k) => entries[k][0] === d.slice(6)))
    .filter(Boolean);
  const depth = path.split("/").length;
  writeFileSync(
    path + "/tsconfig.json",
    JSON.stringify(
      {
        extends: "../".repeat(depth) + "tsconfig.base.json",
        compilerOptions: {
          rootDir: "src",
          outDir: "dist-types",
          tsBuildInfoFile: "dist-types/tsconfig.tsbuildinfo",
        },
        include: ["src/**/*.ts", "src/**/*.tsx", "src/**/*.json"],
        exclude: ["src/**/*.test.ts"],
        references: refs.map((r) => ({ path: "../".repeat(depth) + r })),
      },
      null,
      2,
    ) + "\n",
  );
}
writeFileSync(
  "tsconfig.json",
  JSON.stringify(
    { files: [], references: Object.keys(entries).map((path) => ({ path })) },
    null,
    2,
  ) + "\n",
);
