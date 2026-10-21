---
name: release
description: Cut an Oxbit release in the order the npm and Release workflows need, wait on each step, and stop at the TestFlight internal gate. Use when asked to release, tag, publish, or ship a version to TestFlight or npm.
---

# Release

Follow the sequence in `AGENTS.md` under "Releases". This skill adds the waits and checks.

1. Confirm `main` is green: `gh pr list --state merged --limit 5` for the PRs in the release, and `gh run list --branch main --limit 5`.
2. Pick `X.Y.Z` from the root `package.json` and the change set. Write `docs/testflight/X.Y.Z.md` (plain text, no version header) from the merged PRs, commit it.
3. Before tagging, compare native config and icons with the build testers are on: `git diff --stat <last tag> -- apps/ios/src-tauri/gen/apple apps/ios/src-tauri/icons`. Report any change.
4. `bun run release X.Y.Z --no-desktop --no-ios --commit --tag` with `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=false`.
5. `git push git@github.com:yannelli/oxbit.git HEAD:main`. Poll `gh run list --workflow npm.yml --branch main --json headSha,status` until a run for the release SHA exists.
6. `git push git@github.com:yannelli/oxbit.git vX.Y.Z`. Watch the tag's runs: `gh run list --workflow release.yml --limit 1`, `gh run list --workflow npm.yml --limit 2`. Rerun an npm tag run that shows `cancelled` with `gh run rerun <id>`.
7. When the Release workflow finishes, check the GitHub release assets and `latest.json`. A failed `linux (ubuntu-24.04-arm)` job cannot be attached later (immutable releases); add a follow-up ledger row for the next patch tag.
8. Poll `https://registry.npmjs.org/@oxbit%2f<name>/X.Y.Z` for `sdk`, `cli` and `agent` for up to 2 hours. Do not rerun during the hold.
9. The build is in `Internal Testing` only. Add a device-check ledger row per item in `docs/testflight/X.Y.Z.md` and ask the user to check the build. Promote to `Public Beta` only when the user asks: `node scripts/ios/distribute-testflight.mjs --build <n>` with the App Store Connect API variables.

Report the tag, run URLs, release URL, npm versions seen, and the open device-check rows.
