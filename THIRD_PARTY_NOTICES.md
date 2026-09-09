# Third-party notices

Oxbit's source is [MIT licensed](LICENSE), copyright 2026 Ryan Yannelli
<ryanyannelli@gmail.com> ([yannelli](https://github.com/yannelli)).

Dependencies keep their own licenses. Their package contents,
`pnpm-lock.yaml`, and the `Cargo.lock` files of the desktop and iOS crates
identify the installed versions.

The bundled fonts use the SIL Open Font License 1.1:

- Instrument Sans: copyright 2022 The Instrument Sans Project Authors.
  [License](apps/web/public/fonts/instrumentsans-OFL.txt).
- JetBrains Mono: copyright 2020 The JetBrains Mono Project Authors.
  [License](apps/web/public/fonts/jetbrainsmono-OFL.txt).

The font license files ship with the browser build. The original design
handoff remains unchanged under `design/reference/`.

The VS Code and VS Code High Contrast theme packs adapt palettes from
[Microsoft Visual Studio Code](https://github.com/microsoft/vscode/tree/5a67e0f1cc6b5db6bb8eea3c8c31e1019d8954d1/extensions/theme-defaults/themes),
copyright Microsoft Corporation, under the MIT License.
The full [license notice](packages/features/themes/LICENSE.vscode.txt) is included.

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
