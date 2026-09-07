import * as fs from "node:fs/promises";
const required = ["TAURI_SIGNING_PRIVATE_KEY", "OXBIT_UPDATER_PUBLIC_KEY"];
if (process.platform === "darwin")
  required.push(
    "APPLE_SIGNING_IDENTITY",
    "APPLE_ID",
    "APPLE_PASSWORD",
    "APPLE_TEAM_ID",
  );
for (const key of required)
  if (!process.env[key])
    throw new Error(
      `Release signing requires ${key}. No signing keys are generated automatically.`,
    );
const pkg = JSON.parse(
  await fs.readFile(new URL("../../package.json", import.meta.url), "utf8"),
);
if (
  process.env.GITHUB_REF_TYPE === "tag" &&
  process.env.GITHUB_REF_NAME !== `v${pkg.version}`
)
  throw new Error("The version tag must match the root package version");
await fs.writeFile(
  new URL(
    "../../apps/desktop/src-tauri/tauri.release.conf.json",
    import.meta.url,
  ),
  JSON.stringify(
    {
      bundle: { createUpdaterArtifacts: true },
      plugins: {
        updater: {
          pubkey: process.env.OXBIT_UPDATER_PUBLIC_KEY,
          endpoints: [
            "https://github.com/yannelli/oxbit/releases/latest/download/latest.json",
          ],
        },
      },
    },
    null,
    2,
  ) + "\n",
);
