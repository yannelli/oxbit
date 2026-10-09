# Third-party notices

Oxbit's source is [MIT licensed](LICENSE), copyright 2026 Ryan Yannelli
<ryanyannelli@gmail.com> ([yannelli](https://github.com/yannelli)).

Dependencies keep their own licenses. Their package contents,
`bun.lock`, and the `Cargo.lock` files of the desktop and iOS crates
identify the installed versions.

The bundled fonts use the SIL Open Font License 1.1:

- Instrument Sans: copyright 2022 The Instrument Sans Project Authors.
  [License](apps/web/public/fonts/instrumentsans-OFL.txt).
- JetBrains Mono: copyright 2020 The JetBrains Mono Project Authors.
  [License](apps/web/public/fonts/jetbrainsmono-OFL.txt).

The font license files ship with the browser build.

The VS Code and VS Code High Contrast theme packs adapt palettes from
[Microsoft Visual Studio Code](https://github.com/microsoft/vscode/tree/5a67e0f1cc6b5db6bb8eea3c8c31e1019d8954d1/extensions/theme-defaults/themes),
copyright Microsoft Corporation, under the MIT License.
The full [license notice](packages/features/themes/LICENSE.vscode.txt) is included.

## iOS SSH crates

The iOS app links russh 0.64.1, russh-sftp 3.0.1, ssh-key 0.7.0-rc.11, aws-lc-rs 1.18.1, and their dependencies for SSH and SFTP. They are licensed under Apache-2.0, MIT, BSD-3-Clause, and ISC; aws-lc-sys also carries the OpenSSL and BoringSSL notices in its license file. The crate list and each crate's published license files are in [ios-ssh-crates.txt](apps/web/public/licenses/ios-ssh-crates.txt), which ships with the app.

## iOS language servers

The iOS app bundles yaml-language-server 1.24.0, dockerfile-language-service 0.16.1, dockerfile-utils 0.16.3, bash-language-server 5.8.1, web-tree-sitter 0.27.1, @wasm-fmt/shfmt 0.2.7, @astral-sh/ruff-wasm-web 0.16.10, browser-basedpyright 1.40.2, path-browserify 1.0.1, and their dependencies for on-device language servers, plus SchemaStore and Compose specification JSON schemas. They are licensed under MIT, ISC, BSD-3-Clause, and Apache-2.0. browser-basedpyright embeds typeshed (Apache-2.0). The package list, each package's published license file, and the Ruff and typeshed notices are in [ios-language-servers.txt](apps/web/public/licenses/ios-language-servers.txt), which ships with the app. `node scripts/ios/language-server-notices.mjs` regenerates it.

## Managed language servers

Separately installed language servers and their pinned dependency trees are documented in [managed server notices](apps/runtime/src/managed/NOTICES.md). Original package licenses are retained in the runtime cache; Intelephense is acquired directly from upstream and is not redistributed in Oxbit's open-source server bundles.

## Example icon pack

`examples/icon-packs/jetbrains-icons.zip` repackages the file icon themes of
[JetBrains Icon Theme](https://github.com/peakoss/vscode-jetbrains-icon-theme/tree/f7cc2cfb53390322fd8b9966494e80f73d71ff84)
v2.40.0, copyright 2021-2024 Chad Adams and contributors, under the MIT License.
The Elixir and BEAM icons within it are Apache-2.0 licensed by KronicDeth. The
upstream `LICENSE.md` is inside the archive, and the source URLs and hashes are
recorded in `examples/icon-packs/upstream.json`. Only the 2023+ UI theme data and
its referenced SVGs are redistributed; extension code is not executed. The archive
is not installed on first launch and is not part of any application build.

## Icon-pack verification fixtures

`tests/fixtures/icon-packs/vscode-minimal.zip` contains the MIT-licensed VS Code Minimal icon theme from Microsoft VS Code 1.100.0, commit `19e0f9e681ecb8e5c09d8784acaa601316ca4571`. `material-product-icons.vsix` contains the MIT-licensed Material Product Icons v1.7.1 by Philipp Kief and contributors, commit `46ba756bc8016862b4748c6a94719ce9642119da`. Original licenses are included in both archives. Exact upstream file URLs, hashes, and fixture adaptations are recorded in `tests/fixtures/icon-packs/upstream.json`. These are declarative verification fixtures; extension code is not executed.
