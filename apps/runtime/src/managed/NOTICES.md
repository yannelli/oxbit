# Managed language server notices

Managed servers are separately installed dependencies. Their versions, upstream URLs, dependency licenses and cryptographic integrity values are recorded in the adjacent lock files. Original license files in npm/JRE archives are preserved on installation. The CI packaging job excludes Intelephense.

| Component | License | Upstream |
|---|---|---|
| TypeScript | Apache-2.0 | https://github.com/microsoft/TypeScript |
| TypeScript Language Server | Apache-2.0 | https://github.com/typescript-language-server/typescript-language-server |
| Marksman | MIT | https://github.com/artempyanykh/marksman |
| VS Code language servers extracted | MIT | https://github.com/hrsh7th/vscode-langservers-extracted |
| Vue language server and TypeScript plugin | MIT | https://github.com/vuejs/language-tools |
| Astro language server | MIT | https://github.com/withastro/astro |
| MDX language server | MIT | https://github.com/mdx-js/mdx-analyzer |
| Laravel language server | MIT; standalone binary includes its upstream runtime/dependencies | https://github.com/laravel/lsp/releases/tag/v0.0.31 |
| Dockerfile Language Server | MIT | https://github.com/rcjsuen/dockerfile-language-server |
| Bash Language Server | MIT | https://github.com/bash-lsp/bash-language-server |
| ShellCheck | GPL-3.0-or-later | https://github.com/koalaman/shellcheck/tree/v0.11.0 |
| Taplo | MIT | https://github.com/tamasfe/taplo/tree/0.10.0 |
| Intelephense | Upstream proprietary LICENSE.txt | https://github.com/bmewburn/intelephense-docs |
| LemMinX | EPL-2.0 | https://github.com/eclipse-lemminx/lemminx |
| Eclipse Temurin JRE | GPL-2.0 with Classpath exception and bundled third-party notices | https://github.com/adoptium/temurin21-binaries/releases/tag/jdk-21.0.12.1%2B1 |
| SchemaStore Cargo schema | Apache-2.0 | See schemas/sources.json for the exact revision |

License texts for directly distributed native servers are in `licenses/`. ShellCheck's corresponding source is available at the versioned upstream link above. Temurin contains its license/legal notices in the managed JRE tree; its corresponding source is linked from the pinned release. Oxbit's local Cargo configuration schema is MIT-licensed and intentionally permits additional configuration keys.
