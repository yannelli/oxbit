import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
await import("./prepare-e2e.mjs");
const { root, dataDir } = JSON.parse(
  await readFile("evidence/e2e-workspace.json", "utf8"),
);
const child = spawn("pnpm", ["--filter", "@oxbit/runtime", "start"], {
  stdio: "inherit",
  env: {
    ...process.env,
    PORT: "9278",
    OXBIT_WORKSPACE: root,
    OXBIT_DATA_DIR: dataDir,
    OXBIT_SETTINGS_FILE: dataDir + "/settings.json",
    OXBIT_PROJECTS_DIR: dataDir + "/projects",
    OXBIT_PAIRING_CODE: "oxbit-acceptance-2026",
  },
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code) => process.exit(code ?? 1));
