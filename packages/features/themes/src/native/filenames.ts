/** Whole lowercase basenames per file family. A `parent/name` key matches the file only inside that folder. */
export const fileNameGroups: Record<string, string> = {
  npm: "package.json .npmrc .npmignore",
  node: ".nvmrc .node-version nodemon.json ecosystem.config.js ecosystem.config.cjs",
  yarn: ".yarnrc .yarnrc.yml .yarnclean .yarn-integrity .pnp.cjs .pnp.js .pnp.loader.mjs",
  pnpm: "pnpm-workspace.yaml .pnpmfile.cjs .pnpmfile.mjs pnpmfile.js",
  bun: "bunfig.toml .bunrc .bun-version",
  deno: "deno.json deno.jsonc import_map.json jsr.json",
  lock:
    "package-lock.json npm-shrinkwrap.json yarn.lock pnpm-lock.yaml pnpm.lock bun.lock bun.lockb deno.lock cargo.lock " +
    "poetry.lock pdm.lock uv.lock pipfile.lock pixi.lock pylock.toml requirements.lock requirements-dev.lock gemfile.lock " +
    "gems.locked composer.lock go.sum go.work.sum gopkg.lock mix.lock rebar.lock pubspec.lock package.resolved " +
    "podfile.lock cartfile.resolved flake.lock devenv.lock .terraform.lock.hcl gradle.lockfile packages.lock.json " +
    "paket.lock stack.yaml.lock cabal.project.freeze manifest.toml shard.lock dub.selections.json renv.lock " +
    "cpanfile.snapshot berksfile.lock chart.lock buf.lock module.bazel.lock brewfile.lock.json lazy-lock.json",
  tsconfig:
    "tsconfig.json tsconfig.base.json tsconfig.app.json tsconfig.node.json tsconfig.build.json tsconfig.lib.json " +
    "tsconfig.spec.json tsconfig.test.json tsconfig.eslint.json tsconfig.dev.json tsconfig.prod.json tsconfig.server.json " +
    "tsconfig.web.json tsconfig.esm.json tsconfig.cjs.json tsconfig.types.json tsconfig.e2e.json tsconfig.worker.json " +
    "tsconfig.vitest.json jsconfig.json",
  vite: "vite.config.ts vite.config.js vite.config.mjs vite.config.cjs vite.config.mts vite.config.cts",
  vitest:
    "vitest.config.ts vitest.config.js vitest.config.mjs vitest.config.cjs vitest.config.mts vitest.config.cts " +
    "vitest.workspace.ts vitest.workspace.js vitest.workspace.json vitest.setup.ts vitest.setup.js",
  jest: "jest.config.ts jest.config.js jest.config.mjs jest.config.cjs jest.config.json jest.setup.ts jest.setup.js jest.preset.js",
  playwright:
    "playwright.config.ts playwright.config.js playwright.config.mjs playwright.config.cjs playwright.config.mts " +
    "playwright-ct.config.ts",
  cypress: "cypress.config.ts cypress.config.js cypress.config.mjs cypress.config.cjs cypress.json cypress.env.json",
  eslint:
    "eslint.config.js eslint.config.mjs eslint.config.cjs eslint.config.ts eslint.config.mts eslint.config.cts .eslintrc " +
    ".eslintrc.js .eslintrc.cjs .eslintrc.mjs .eslintrc.ts .eslintrc.json .eslintrc.yml .eslintrc.yaml .eslintignore .eslintcache",
  prettier:
    ".prettierrc .prettierrc.js .prettierrc.ts .prettierrc.cjs .prettierrc.cts .prettierrc.mjs .prettierrc.mts " +
    ".prettierrc.json .prettierrc.json5 .prettierrc.toml .prettierrc.yaml .prettierrc.yml prettier.config.js " +
    "prettier.config.ts prettier.config.cjs prettier.config.cts prettier.config.mjs prettier.config.mts .prettierignore",
  biome: "biome.json biome.jsonc",
  stylelint:
    ".stylelintrc .stylelintrc.json .stylelintrc.yml .stylelintrc.yaml .stylelintrc.js .stylelintrc.cjs .stylelintrc.mjs " +
    "stylelint.config.js stylelint.config.cjs stylelint.config.mjs stylelint.config.ts .stylelintignore",
  babel:
    ".babelrc .babelrc.json .babelrc.js .babelrc.cjs .babelrc.mjs babel.config.js babel.config.cjs babel.config.mjs " +
    "babel.config.json babel.config.ts",
  webpack:
    "webpack.config.js webpack.config.ts webpack.config.mjs webpack.config.cjs webpack.config.babel.js webpack.common.js " +
    "webpack.dev.js webpack.prod.js webpack.mix.js rspack.config.js rspack.config.ts rspack.config.mjs",
  rollup: "rollup.config.js rollup.config.mjs rollup.config.cjs rollup.config.ts rolldown.config.ts rolldown.config.js",
  esbuild: "esbuild.config.js esbuild.config.mjs esbuild.config.cjs esbuild.config.ts",
  turbo: "turbo.json turbo.jsonc",
  nx: "nx.json project.json .nxignore lerna.json",
  tailwind:
    "tailwind.config.js tailwind.config.cjs tailwind.config.mjs tailwind.config.ts tailwind.config.cts tailwind.config.mts",
  postcss:
    "postcss.config.js postcss.config.cjs postcss.config.mjs postcss.config.ts postcss.config.cts postcss.config.mts " +
    "postcss.config.json .postcssrc .postcssrc.json .postcssrc.js .postcssrc.cjs .postcssrc.mjs .postcssrc.yml .postcssrc.yaml",
  next: "next.config.js next.config.mjs next.config.cjs next.config.ts next.config.mts next-env.d.ts",
  nuxt: "nuxt.config.ts nuxt.config.js nuxt.config.mjs .nuxtrc",
  angular: "angular.json .angular-cli.json angular-cli.json",
  gatsby:
    "gatsby-config.js gatsby-config.ts gatsby-config.mjs gatsby-node.js gatsby-node.ts gatsby-node.mjs gatsby-browser.js " +
    "gatsby-browser.ts gatsby-browser.tsx gatsby-browser.jsx gatsby-ssr.js gatsby-ssr.ts gatsby-ssr.tsx gatsby-ssr.jsx",
  storybook:
    ".storybook/main.ts .storybook/main.js .storybook/main.mjs .storybook/main.cjs .storybook/preview.ts " +
    ".storybook/preview.tsx .storybook/preview.js .storybook/preview.jsx .storybook/preview.mjs .storybook/manager.ts " +
    ".storybook/manager.js .storybook/preview-head.html .storybook/manager-head.html",
  vue: ".vuerc vue.config.js vue.config.ts",
  svelte: "svelte.config.js svelte.config.ts svelte.config.mjs svelte.config.cjs",
  astro: "astro.config.mjs astro.config.ts astro.config.js astro.config.mts astro.config.cjs",
  prisma: "prisma.config.ts",
  drizzle: "drizzle.config.ts drizzle.config.js drizzle.config.mjs drizzle.config.cjs drizzle.config.json",
  wrangler: "wrangler.toml wrangler.json wrangler.jsonc",
  tauri:
    "tauri.conf.json tauri.conf.json5 tauri.conf.toml tauri.linux.conf.json tauri.macos.conf.json tauri.windows.conf.json " +
    "tauri.ios.conf.json tauri.android.conf.json",
  vercel: "vercel.json .vercelignore now.json",
  netlify: "netlify.toml _redirects _headers",
  firebase:
    "firebase.json .firebaserc firestore.rules firestore.indexes.json storage.rules database.rules.json apphosting.yaml",
  renovate: "renovate.json renovate.json5 .renovaterc .renovaterc.json .renovaterc.json5",
  helm: "chart.yaml values.yaml values.schema.json .helmignore helmfile.yaml helmfile.yml",
  gitlab: ".gitlab-ci.yml .gitlab-ci.yaml",
  travis: ".travis.yml .travis.yaml",
  jenkins: "jenkinsfile",
  azure:
    "azure-pipelines.yml azure-pipelines.yaml .azure-pipelines.yml azure.yaml local.settings.json staticwebapp.config.json",
  bitbucket: "bitbucket-pipelines.yml bitbucket-pipelines.yaml",
  circleci: ".circleci/config.yml .circleci/config.yaml",
  docker:
    "dockerfile containerfile dockerfile.dev dockerfile.development dockerfile.prod dockerfile.production dockerfile.test " +
    "dockerfile.staging dockerfile.local dockerfile.ci dockerfile.base dockerfile.build dockerfile.alpine dockerfile.debian " +
    "dockerfile.windows dockerfile.e2e dockerfile.release containerfile.dev containerfile.prod containerfile.test " +
    "docker-compose.yml docker-compose.yaml docker-compose.override.yml docker-compose.override.yaml docker-compose.dev.yml " +
    "docker-compose.prod.yml docker-compose.test.yml docker-compose.local.yml docker-compose.ci.yml compose.yml compose.yaml " +
    "compose.override.yml compose.override.yaml compose.dev.yml compose.prod.yml docker-bake.hcl docker-bake.json " +
    ".hadolint.yaml devcontainer.json .devcontainer.json",
  git:
    ".gitignore .gitattributes .gitmodules .gitkeep .keep .git-blame-ignore-revs .gitconfig .gitmessage .gitignore_global " +
    ".lfsconfig .git-credentials .mailmap .git .hgrc commit_editmsg merge_msg tag_editmsg git-rebase-todo " +
    ".pre-commit-config.yaml .pre-commit-hooks.yaml commitlint.config.js commitlint.config.ts commitlint.config.mjs " +
    ".commitlintrc .commitlintrc.json .commitlintrc.yml .czrc",
  github: "codeowners dependabot.yml dependabot.yaml funding.yml action.yml action.yaml",
  ignore:
    ".dockerignore .containerignore .gcloudignore .vscodeignore .ignore .rgignore .fdignore .agignore .hgignore .bzrignore " +
    ".cvsignore .slugignore .cfignore .ebignore .funcignore .tfignore .eleventyignore .markdownlintignore .jshintignore " +
    ".nodemonignore .aiderignore .cursorignore .geminiignore .codeiumignore",
  env:
    ".env .env.local .env.example .env.sample .env.template .env.defaults .env.schema .env.vault .env.keys .env.test " +
    ".env.test.local .env.development .env.development.local .env.production .env.production.local .env.staging " +
    ".env.staging.local .env.dev .env.prod .env.ci .env.e2e .env.preview .envrc .flaskenv .dev.vars .renviron",
  editorconfig: ".editorconfig",
  agent:
    "agents.md agent.md agents.override.md claude.md claude.local.md gemini.md qwen.md crush.md warp.md skill.md " +
    ".cursorrules .windsurfrules .clinerules .roorules .goosehints .rules copilot-instructions.md llms.txt llms-full.txt " +
    ".mcp.json .cursor/mcp.json .vscode/mcp.json .claude/settings.json .claude/settings.local.json .gemini/settings.json " +
    ".junie/guidelines.md .aider.conf.yml .aider.model.settings.yml opencode.json opencode.jsonc .coderabbit.yaml .coderabbit.yml",
  license:
    "license licence license.md licence.md license.txt licence.txt license.rst license-mit license-apache copying " +
    "copying.md copying.txt copying.lesser unlicense notice notice.md notice.txt copyright patents",
  markdown:
    "readme readme.md contributing contributing.md changelog.md code_of_conduct.md security.md .markdownlint.json " +
    ".markdownlint.jsonc .markdownlint.yaml .markdownlint.yml .markdownlintrc mkdocs.yml mkdocs.yaml",
  text: "readme.txt authors contributors maintainers changelog changes history news todo thanks credits",
  document: "readme.rst readme.adoc",
  shell:
    ".bashrc .bash_profile .bash_login .bash_logout .bash_aliases .bash_completion .profile .zshrc .zshenv .zprofile " +
    ".zlogin .zlogout .kshrc .cshrc .tcshrc .mkshrc .fishrc .inputrc .xinitrc .xprofile .xsession .shellcheckrc pkgbuild " +
    "apkbuild configure",
  vim: ".vimrc .gvimrc .ideavimrc .exrc _vimrc _gvimrc",
  config:
    ".browserslistrc browserslist .htaccess .tool-versions .mise.toml mise.toml .lintstagedrc .lintstagedrc.json " +
    "lint-staged.config.js .releaserc .releaserc.json release.config.js .swcrc .parcelrc .flowconfig .jshintrc " +
    ".watchmanconfig .clang-format _clang-format .clang-tidy .clangd .gitpod.yml .replit procfile procfile.dev fly.toml " +
    "railway.json railway.toml render.yaml serverless.yml cdk.json pulumi.yaml skaffold.yaml kustomization.yaml tiltfile " +
    ".sops.yaml .drone.yml appveyor.yml .appveyor.yml cloudbuild.yaml codemagic.yaml bitrise.yml .woodpecker.yml " +
    "buildspec.yml .buildkite/pipeline.yml .wgetrc .curlrc .screenrc .xresources .xdefaults .nanorc gulpfile.js " +
    "gulpfile.ts gulpfile.mjs gruntfile.js gruntfile.cjs .ssh/config .changeset/config.json .codecov.yml codecov.yml",
  "python-manifest":
    "pyproject.toml setup.py setup.cfg pipfile manifest.in tox.ini noxfile.py .python-version pyvenv.cfg requirements.txt " +
    "requirements-dev.txt requirements_dev.txt requirements-test.txt requirements_test.txt requirements-docs.txt " +
    "requirements.in requirements-dev.in dev-requirements.txt test-requirements.txt constraints.txt environment.yml " +
    "environment.yaml pixi.toml poetry.toml pdm.toml hatch.toml uv.toml .flake8 .pylintrc pylintrc mypy.ini .mypy.ini " +
    "ruff.toml .ruff.toml pyrightconfig.json .isort.cfg .bandit .pypirc .condarc",
  "test-python": "pytest.ini conftest.py .coveragerc tests.py",
  python: "py.typed sconstruct sconscript",
  "rust-manifest":
    "cargo.toml rust-toolchain rust-toolchain.toml rustfmt.toml .rustfmt.toml clippy.toml .clippy.toml deny.toml " +
    "rust-project.json .cargo/config .cargo/config.toml",
  "go-manifest":
    "go.mod go.work .go-version .golangci.yml .golangci.yaml .golangci.toml .golangci.json .goreleaser.yml .goreleaser.yaml " +
    "gopkg.toml .air.toml",
  proto: "buf.yaml buf.gen.yaml buf.work.yaml",
  sql: "sqlc.yaml sqlc.yml sqlc.json .psqlrc",
  database: ".sqliterc",
  "ruby-manifest":
    "gemfile gems.rb rakefile .ruby-version .ruby-gemset .gemrc berksfile .rubocop.yml .rubocop_todo.yml .bundle/config",
  ruby:
    "vagrantfile brewfile fastfile appfile matchfile pluginfile gymfile scanfile snapfile dangerfile guardfile capfile " +
    ".irbrc .pryrc",
  "test-ruby": ".rspec .rspec_parallel spec_helper.rb rails_helper.rb .simplecov",
  "php-manifest":
    "composer.json phpunit.xml phpunit.xml.dist .php-cs-fixer.php .php-cs-fixer.dist.php .php_cs phpstan.neon " +
    "phpstan.neon.dist psalm.xml phpcs.xml phpcs.xml.dist pint.json rector.php",
  php: "artisan",
  "swift-manifest":
    "package.swift podfile cartfile cartfile.private .swiftlint.yml .swiftformat .swift-version .xcode-version",
  "dart-manifest": "pubspec.yaml pubspec_overrides.yaml analysis_options.yaml l10n.yaml melos.yaml .fvmrc",
  "elixir-manifest": "mix.exs .formatter.exs .credo.exs",
  erlang: "rebar.config elvis.config",
  "haskell-manifest": "stack.yaml cabal.project cabal.project.local package.yaml hie.yaml .hlint.yaml",
  haskell: ".ghci",
  dotnet:
    "directory.build.props directory.build.targets directory.packages.props global.json nuget.config packages.config " +
    "launchsettings.json appsettings.json appsettings.development.json appsettings.production.json web.config " +
    "app.config omnisharp.json paket.dependencies .config/dotnet-tools.json",
  maven: "pom.xml mvnw mvnw.cmd .mvn/maven.config .mvn/jvm.config",
  gradle:
    "build.gradle build.gradle.kts settings.gradle settings.gradle.kts gradle.properties gradlew gradlew.bat " +
    "gradle-wrapper.properties libs.versions.toml init.gradle",
  java: ".java-version .sdkmanrc manifest.mf lombok.config",
  scala: "build.sbt .scalafmt.conf .scalafix.conf",
  "clojure-manifest": "project.clj deps.edn shadow-cljs.edn bb.edn build.boot",
  "elm-manifest": "elm.json",
  "ocaml-manifest": "dune dune-project dune-workspace opam",
  ocaml: ".ocamlformat .ocamlinit",
  "nim-manifest": "nim.cfg",
  "gleam-manifest": "gleam.toml",
  "julia-manifest": "project.toml",
  r: ".rprofile .rhistory .lintr",
  "lua-manifest": ".luarc.json .luarc.jsonc",
  lua: ".luacheckrc stylua.toml .stylua.toml .busted",
  perl: "cpanfile .perltidyrc .perlcriticrc",
  "crystal-manifest": "shard.yml",
  "d-manifest": "dub.json dub.sdl",
  nix: "devbox.json devenv.yaml",
  haxe: "haxelib.json",
  terraform: ".terraformrc terraform.rc .terraform-version terragrunt.hcl .tflint.hcl",
  makefile:
    "makefile gnumakefile bsdmakefile makefile.am makefile.in build.ninja configure.ac taskfile.yml taskfile.yaml",
  cmake: "cmakelists.txt cmakecache.txt cmakepresets.json cmakeuserpresets.json",
  "cpp-manifest": "meson.build meson_options.txt meson.options vcpkg.json vcpkg-configuration.json conanfile.txt conanfile.py",
  justfile: "justfile .justfile",
  bazel: "build build.bazel workspace workspace.bazel module.bazel .bazelrc .bazelversion .bazelignore",
  "test-javascript": ".mocharc .mocharc.js .mocharc.cjs .mocharc.json .mocharc.yml .mocharc.yaml karma.conf.js .nycrc .nycrc.json",
  yaml: ".yamllint",
  toml: ".taplo.toml taplo.toml",
  certificate: "id_rsa id_ed25519 id_ecdsa id_dsa authorized_keys known_hosts .netrc .pgpass .htpasswd",
  binary: ".ds_store thumbs.db",
};
