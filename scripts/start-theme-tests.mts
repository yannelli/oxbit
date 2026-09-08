import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createRuntime } from "../apps/runtime/src/runtime.js";
const root = await mkdtemp(join(tmpdir(), "oxbit-theme-tests-"));
await writeFile(
  join(root, "README.md"),
  "# Theme runtime\n\n**Strong** and *emphasis*\n",
);
const runtime = await createRuntime({
  root,
  port: 9290,
  dataDir: root + "-data",
  settingsFile: join(root + "-data", "settings.json"),
  projectsDir: join(root + "-data", "projects"),
  pairingCode: "oxbit-theme-test",
});
const vite = spawn(
  process.execPath,
  [
    resolve("node_modules/vite/bin/vite.js"),
    "--host",
    "127.0.0.1",
    "--port",
    "9289",
    "--strictPort",
  ],
  { cwd: "apps/web", stdio: "inherit" },
);
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  vite.kill("SIGTERM");
  await runtime.close();
  await rm(root, { recursive: true, force: true });
  await rm(root + "-data", { recursive: true, force: true });
};
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    void stop().then(() => process.exit(0));
  });
vite.on("exit", (code) => {
  void stop().then(() => process.exit(code ?? 0));
});
