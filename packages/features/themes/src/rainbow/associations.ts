import { fileAssociations } from "../classicos98/associations.js";

const map = (groups: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(groups).flatMap(([id, names]) =>
      names.split(" ").map((name) => [name, id]),
    ),
  );

/** Shared language coverage, extended with compound extensions and tool manifests. */
export const rainbowAssociations = {
  ...fileAssociations,
  rootFolder: "workspace",
  rootFolderExpanded: "workspaceOpen",
  fileExtensions: {
    ...fileAssociations.fileExtensions,
    ...map({
      astro: "astro",
      dart: "dart",
      elixir: "ex exs heex eex",
      erlang: "erl hrl",
      haskell: "hs lhs",
      lua: "lua",
      perl: "pl pm",
      r: "r rmd",
      scala: "scala sc",
      clojure: "clj cljs cljc edn",
      graphql: "graphql gql",
      kotlin: "kt kts",
      docker: "dockerfile",
      terraform: "tf tfvars",
      protobuf: "proto",
      solidity: "sol",
      notebook: "ipynb",
      document: "pdf doc docx odt pages",
      spreadsheet: "csv tsv xls xlsx ods",
      test: "test.ts test.tsx test.js test.jsx spec.ts spec.tsx spec.js spec.jsx spec.mjs test.mjs",
      typescript: "d.ts d.mts d.cts",
      audio: "mp3 wav ogg flac aac m4a aiff opus wma",
      video: "mp4 mov webm avi mkv m4v mpeg mpg",
      image: "heic tiff tif psd ai eps",
      config: "config.ts config.js config.mjs config.cjs config.json",
      archive: "tgz zst br",
      binary: "lib obj pdb node",
      zig: "zig zon",
      ocaml: "ml mli",
    }),
  },
  fileNames: {
    ...fileAssociations.fileNames,
    ...map({
      node: "package.json package-lock.json npm-shrinkwrap.json .npmrc .nvmrc .node-version .yarnrc .yarnrc.yml pnpm-workspace.yaml bun.lockb bun.lock",
      typescript:
        "tsconfig.json tsconfig.app.json tsconfig.node.json tsconfig.build.json jsconfig.json",
      docker:
        "dockerfile dockerfile.dev dockerfile.prod .dockerignore docker-compose.yml docker-compose.yaml compose.yml compose.yaml",
      config:
        "vite.config.ts vite.config.js vite.config.mjs vitest.config.ts vitest.config.js webpack.config.js webpack.config.ts rollup.config.js rollup.config.mjs next.config.js next.config.mjs next.config.ts nuxt.config.ts svelte.config.js astro.config.mjs angular.json .babelrc babel.config.js .browserslistrc .prettierrc .prettierrc.json .prettierignore prettier.config.js prettier.config.mjs eslint.config.js eslint.config.mjs eslint.config.ts .eslintrc .eslintrc.json .eslintignore .stylelintrc tailwind.config.js tailwind.config.ts postcss.config.js postcss.config.cjs deno.json deno.jsonc",
      test: "playwright.config.ts playwright.config.js cypress.config.ts cypress.config.js jest.config.js jest.config.ts pytest.ini .coveragerc",
      python:
        "pyproject.toml requirements.txt setup.py setup.cfg pipfile tox.ini",
      rust: "cargo.toml rust-toolchain.toml rustfmt.toml clippy.toml",
      go: "go.mod go.sum go.work",
      ruby: "gemfile rakefile .ruby-version",
      java: "pom.xml build.gradle settings.gradle gradlew",
      php: "composer.json phpunit.xml artisan",
      git: ".gitconfig .gitmessage .mailmap .git-blame-ignore-revs",
      markdown:
        "readme.rst readme.txt code_of_conduct.md security.md agents.md claude.md contributing license.md",
      shell: "makefile gnumakefile justfile .zshenv .bash_logout .fishrc",
      terraform: ".terraform.lock.hcl",
      swift: "package.swift",
      document: "license.txt copying.txt notice.txt",
    }),
  },
  languageIds: {
    ...fileAssociations.languageIds,
    ...map({
      astro: "astro",
      dart: "dart",
      elixir: "elixir",
      erlang: "erlang",
      haskell: "haskell",
      lua: "lua",
      perl: "perl",
      r: "r",
      scala: "scala",
      clojure: "clojure",
      graphql: "graphql",
      kotlin: "kotlin",
      docker: "dockerfile",
      terraform: "terraform hcl",
      protobuf: "proto",
      zig: "zig",
      ocaml: "ocaml",
    }),
  },
  folderNames: map({
    source: "src source lib packages apps",
    tests: "test tests __tests__ spec specs e2e",
    assets: "assets images public static media",
    docs: "docs doc documentation",
    config: ".config .vscode .idea config",
    git: ".git .github .gitlab",
    dependencies: "node_modules vendor .venv",
    build: "dist build out target coverage",
    scripts: "scripts bin tools",
    components: "components views pages routes",
  }),
};
