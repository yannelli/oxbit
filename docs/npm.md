# npm packages

Created: 2026-10-05. Last updated: 2026-10-05.

`.github/workflows/npm.yml` publishes two packages to the
[`@oxbit` npm org](https://www.npmjs.com/org/oxbit).

| Package | Built from | Version source | Publishes when |
| --- | --- | --- | --- |
| `@oxbit/sdk` | `packages/sdk` | `packages/sdk/package.json`, which must equal `SDK_VERSION` | A push to `main` carries a version that npm does not have |
| `@oxbit/cli` | `apps/runtime` and `apps/web` builds | Root `package.json` | A `v<version>` tag is pushed and npm does not have that version |

Versions with a hyphen (`0.4.0-alpha.1`) publish under the `next` dist-tag. Other
versions publish under `latest`. npm rejects a version number that was published
before, including after an unpublish.

Pull requests that change the publish inputs run both packages with `--dry-run`.

## Staging

`node scripts/npm/publish.mjs <sdk|cli> [--expect-tag vX.Y.Z] [--dry-run]` stages
the package in a temporary directory with a generated `package.json`, then runs
`npm publish`. It skips the publish when npm already has the version. Workspace
manifests export TypeScript sources, so the generated manifests point at built files.

- `@oxbit/sdk`: an esbuild ESM bundle in `dist/index.js` and `tsc` declarations.
  `react` and `@types/react` are optional peers.
- `@oxbit/cli`:

  | Path | Purpose |
  | --- | --- |
  | `runtime/dist/index.js` | The `oxbit` bin |
  | `runtime/package.json` | Version printed by `oxbit --version` |
  | `web/dist/` | Editor files, served from `../../web/dist/` relative to the bin |
  | `scripts/repair-pty.mjs` | `postinstall` |

  Source maps are excluded. Dependencies are the non-workspace dependencies of
  `apps/runtime/package.json`, pinned to the installed versions.

Check both packages locally:

```sh
bun run build
node scripts/npm/publish.mjs sdk --dry-run
node scripts/npm/publish.mjs cli --dry-run
```

The script prints the staging directory. `npm pack <directory>` makes an
installable tarball.

## Install scripts

node-pty 1.1.0 has no Linux prebuild, so its install script compiles the addon.
Its macOS `spawn-helper` prebuild installs with mode 0644, and the CLI
`postinstall` makes it executable. npm 11, bundled with Node 24, runs install
scripts. npm 12 runs them only for allowed packages:

```sh
npm install -g @oxbit/cli --allow-scripts=@oxbit/cli,node-pty
```

`allow-scripts` matches the resolved identity. A tarball install is identified by
its path, so the package name does not match it.

## Authentication

The publish job has `id-token: write`. npm uses trusted publishing (OIDC) when the
package has a trusted publisher for `npm.yml`. Otherwise it uses `NODE_AUTH_TOKEN`
from the `NPM_TOKEN` repository secret. Both paths publish with provenance.

`NPM_TOKEN` is a granular token for `@oxbit` (package and org write, bypass 2FA).
It expires on 2027-01-03.

### Configure trusted publishing

npm accepts a trusted publisher only for a package that exists. Configure
`@oxbit/sdk` after its first publish and `@oxbit/cli` after the first tag publish.

On npmjs.com, open **Packages → `<package>` → Settings → Trusted publishing** and
choose GitHub Actions:

| Field | Value |
| --- | --- |
| Organization or user | `yannelli` |
| Repository | `oxbit` |
| Workflow filename | `npm.yml` |
| Environment name | empty |
| Allowed actions | publish |

Or use npm 11.15 or later after `npm login`. The account needs 2FA, and
`npm trust` rejects bypass-2FA tokens.

```sh
npm trust github @oxbit/sdk --repo yannelli/oxbit --file npm.yml --allow-publish -y
npm trust github @oxbit/cli --repo yannelli/oxbit --file npm.yml --allow-publish -y
npm trust list @oxbit/sdk
```

After both packages trust `npm.yml`:

1. In each package's Publishing access settings, select "Require two-factor
   authentication and disallow tokens".
2. Run `gh secret delete NPM_TOKEN -R yannelli/oxbit`.
3. Revoke the token on npmjs.com.

Trusted publishing needs npm 11.5.1 or later, Node 22.14.0 or later, and
GitHub-hosted runners. CI uses Node 24.20.0, which bundles npm 11.19.0.
Provenance needs `repository.url` to match this repository; the generated
manifests set it.

## References

- [Trusted publishing for npm packages](https://docs.npmjs.com/trusted-publishers)
- [Generating provenance statements](https://docs.npmjs.com/generating-provenance-statements)
- [npm unpublish policy](https://docs.npmjs.com/policies/unpublish)
- `npm help trust` (npm 11.15 or later)
- `allow-scripts` in `npm help config` (npm 12)

Use these references when changing publish authentication, the workflow filename,
or install-script handling.
