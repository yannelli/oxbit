/** Lowercase folder names per folder family. A `parent/name` key matches the folder only inside that parent. */
export const folderNameGroups: Record<string, string> = {
  source:
    "src source sources lib libs app apps packages pkg internal cmd core crates modules server client api backend " +
    "frontend web services service shared common utils util helpers hooks store stores models controllers middleware " +
    "middlewares handlers providers contexts context features domain types typings @types interfaces plugins extensions " +
    "workers jobs cli sdk main mailers resolvers actions reducers slices state composables directives guards " +
    "interceptors entities repositories include functions lambda lambdas serializers validators schemas dto dtos events " +
    "listeners observers policies http routers proto protos graphql src-tauri",
  tests:
    "test tests __tests__ __test__ spec specs e2e integration unit fixtures __fixtures__ __snapshots__ __mocks__ mocks " +
    "mock testing testdata test-data test_data __testfixtures__ __screenshots__ cypress playwright benchmarks benchmark " +
    "bench benches snapshots stubs fakes androidtest",
  resources:
    "assets asset public static images image img imgs icons icon fonts font locales locale i18n l10n lang langs " +
    "translations media res resources resource audio sounds sound music video videos styles style css scss sass less " +
    "stylesheets svg svgs sprites textures raw drawable mipmap values www wwwroot assets.xcassets images.xcassets " +
    "media.xcassets artwork art graphics pictures photos screenshots logos brand branding themes theme shaders " +
    "animations design",
  docs:
    "docs doc documentation wiki guides guide tutorials tutorial examples example samples sample demo demos manual man " +
    "adr adrs rfcs rfc notes .changeset content posts blog book javadoc jsdoc typedoc apidocs api-docs .vitepress " +
    ".vuepress cookbook recipes proposals website",
  components:
    "components component views view pages page routes layouts layout widgets ui templates template partials screens " +
    "containers sections islands blocks elements stories fragments organisms molecules atoms primitives modals dialogs " +
    "forms emails",
  config:
    "config configs configuration .config conf cfg etc settings .settings .vscode .idea .fleet .zed .nova .helix .vim " +
    ".emacs.d .vs .run .devcontainer .circleci .buildkite .storybook .vercel .netlify .firebase .docker docker " +
    "environments environment deploy deployment deployments infra infrastructure terraform k8s kubernetes helm charts " +
    "ansible nginx .ebextensions .platform .aws .ssh .kube ci .ci .cargo .mvn .azure .azuredevops .pulumi .swiftpm",
  scripts:
    "scripts script bin tools tool .bin sbin tasks automation cron devtools hack .github/workflows .gitea/workflows " +
    ".forgejo/workflows",
  git:
    ".git .github .gitlab .husky .githooks .gitea .forgejo .svn .hg .jj .bzr .github/issue_template " +
    ".gitlab/issue_templates .gitlab/merge_request_templates",
  database:
    "db database databases migrations migration migrate seeds seeders seed sql prisma drizzle supabase data datasets " +
    "dumps liquibase flyway alembic",
  build:
    "dist build builds out output target coverage release releases obj .build deriveddata artifacts generated gen " +
    "__generated__ storybook-static _site _build .next .nuxt .output .svelte-kit .astro .cache .docusaurus .expo " +
    ".gradle .dart_tool .angular .turbo .nx .parcel-cache .vite .wrangler .serverless .aws-sam .webpack .sass-cache " +
    "cmake-build-debug cmake-build-release bazel-bin bazel-out bazel-testlogs tmp temp .tmp .temp logs log .ruff_cache " +
    ".mypy_cache .pytest_cache .tox .nox .hypothesis __pycache__ .ipynb_checkpoints .eggs .elixir_ls .stack-work " +
    "dist-newstyle .cpcache .nyc_output htmlcov test-results playwright-report .zig-cache zig-cache zig-out .metals " +
    ".bloop .bsp .kotlin .cxx .externalnativebuild",
  dependencies:
    "node_modules vendor vendors .venv venv virtualenv .virtualenv bower_components jspm_packages .yarn .pnpm-store " +
    ".pnpm .npm third_party third-party thirdparty external externals extern deps _deps .bundle pods carthage " +
    ".pub-cache site-packages .terraform elm-stuff .m2 vcpkg_installed submodules .conda .pixi .gem",
  agent:
    ".claude .cursor .windsurf .codex .gemini .continue .roo .cline .clinerules .kiro .junie .amazonq .opencode " +
    ".agents .agent .goose .augment .copilot .qwen .crush .amp .factory .trae .openhands .paseo prompts " +
    ".github/prompts .github/instructions .github/chatmodes .github/agents .claude/commands .claude/agents " +
    ".claude/skills .claude/hooks .cursor/rules .agents/skills .windsurf/rules .windsurf/workflows",
};

/** Lowercase VS Code and community language IDs per file family; used when no name or extension matches. */
export const languageIdGroups: Record<string, string> = {
  typescript: "typescript",
  typescriptreact: "typescriptreact tsx",
  javascript: "javascript",
  actionscript: "actionscript",
  javascriptreact: "javascriptreact jsx",
  python: "python cython",
  "python-manifest": "pip-requirements",
  rust: "rust",
  go: "go",
  "go-manifest": "go.mod go.work gomod gowork",
  lock: "go.sum gosum",
  java: "java",
  kotlin: "kotlin",
  scala: "scala sbt",
  groovy: "groovy",
  gradle: "gradle",
  jenkins: "jenkinsfile",
  c: "c",
  shader: "glsl hlsl wgsl shaderlab metal",
  cpp: "cpp arduino",
  cuda: "cuda-cpp cuda",
  objectivec: "objective-c objective-cpp objc objcpp",
  csharp: "csharp",
  fsharp: "fsharp",
  vb: "vb",
  swift: "swift",
  dart: "dart",
  ruby: "ruby",
  php: "php",
  blade: "blade",
  perl: "perl perl6 raku",
  lua: "lua luau",
  r: "r rmd",
  julia: "julia juliamarkdown",
  haskell: "haskell purescript",
  "haskell-manifest": "cabal",
  elixir: "elixir",
  erlang: "erlang",
  clojure: "clojure",
  elm: "elm",
  ocaml: "ocaml ocaml.interface ocaml.ocamllex ocaml.menhir",
  "ocaml-manifest": "dune dune-project opam",
  reason: "reason rescript",
  nim: "nim",
  zig: "zig",
  vlang: "v",
  crystal: "crystal",
  d: "d",
  fortran: "fortran fortran-modern fortranfreeform fortranfixedform",
  cobol: "cobol",
  pascal: "pascal objectpascal delphi",
  ada: "ada",
  assembly: "asm nasm masm arm riscv",
  solidity: "solidity",
  gleam: "gleam",
  lisp: "lisp commonlisp scheme racket fennel",
  tcl: "tcl",
  powershell: "powershell",
  coffeescript: "coffeescript",
  haxe: "haxe hxml",
  verilog: "verilog systemverilog",
  vhdl: "vhdl",
  wasm: "wat wasm",
  awk: "awk",
  vim: "vim viml vimscript",
  vue: "vue vue-html",
  svelte: "svelte",
  astro: "astro",
  graphql: "graphql",
  terraform: "terraform terraform-vars opentofu",
  hcl: "hcl",
  nix: "nix",
  notebook: "jupyter",
  html: "html",
  xml: "xml xsl",
  template:
    "handlebars pug jade haml slim jinja twig liquid nunjucks mustache ejs erb eex gotmpl django-html django-txt " +
    "html-eex heex phoenix-heex latte smarty templ",
  razor: "razor aspnetcorerazor",
  css: "css tailwindcss",
  postcss: "postcss",
  sass: "scss sass",
  less: "less",
  stylus: "stylus",
  markdown: "markdown quarto",
  mdx: "mdx",
  latex: "latex tex bibtex doctex",
  typst: "typst",
  json: "json jsonl jsonnet snippets",
  jsonc: "jsonc json5",
  yaml: "yaml ansible",
  github: "github-actions-workflow",
  toml: "toml",
  config: "ini properties nginx apacheconf ssh_config crontab rego",
  editorconfig: "editorconfig",
  env: "dotenv",
  proto: "proto proto3 protobuf textproto thrift",
  spreadsheet: "csv tsv",
  document: "restructuredtext asciidoc org",
  text: "plaintext log http",
  diff: "diff",
  sql: "sql mysql pgsql plsql tsql",
  prisma: "prisma",
  shell: "shellscript bash sh zsh fish nushell bat",
  git: "git-commit git-rebase",
  ignore: "ignore",
  docker: "dockerfile dockercompose",
  makefile: "makefile",
  cmake: "cmake",
  "cpp-manifest": "meson",
  justfile: "just justfile",
  bazel: "starlark bazel",
  helm: "helm",
  azure: "azure-pipelines bicep",
  agent: "prompt instructions chatmode",
  vector: "svg",
};
