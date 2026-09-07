import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
await import("./prepare-e2e.mjs");
const { root, dataDir } = JSON.parse(
  await readFile("evidence/e2e-workspace.json", "utf8"),
);
const child = spawn("pnpm", ["--filter", "@zapp/runtime", "start"], {
  stdio: "inherit",
  env: {
    ...process.env,
    PORT: "9278",
    ZAPP_WORKSPACE: root,
    ZAPP_DATA_DIR: dataDir,
    ZAPP_PAIRING_CODE: "zapp-acceptance-2026",
  },
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code) => process.exit(code ?? 1));
