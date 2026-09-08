import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createRuntime } from "../../apps/runtime/src/runtime.js";
import { runCommand } from "../../apps/runtime/src/processes.js";
const dir = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "oxbit-tasks-browser-"),
  ),
  root = path.join(dir, "project");
await fs.mkdir(path.join(root, ".vscode"), { recursive: true });
await fs.writeFile(path.join(root, "README.md"), "# Task fixture\n");
await fs.writeFile(
  path.join(root, "server.cjs"),
  `require('http').createServer((q,r)=>r.end('Oxbit task service')).listen(+process.env.OXBIT_PORT,process.env.OXBIT_HOST,()=>console.log('Listening at http://'+process.env.OXBIT_HOST+':'+process.env.OXBIT_PORT+'/'));`,
);
await fs.writeFile(path.join(root, ".gitignore"), "generated\n");
await fs.writeFile(
  path.join(root, ".vscode/tasks.json"),
  "// Retain this comment when editing tasks\n" +
    JSON.stringify(
      {
        version: "2.0.0",
        tasks: [
          {
            label: "Web service",
            type: "process",
            command: process.execPath,
            args: ["server.cjs"],
            isBackground: true,
            detail: "Keep this IDE detail",
            oxbit: {
              port: "auto",
              ready: {
                url: "http://$OXBIT_HOST:$OXBIT_PORT/",
                intervalMs: 100,
              },
            },
          },
          {
            label: "Build",
            type: "shell",
            command: "printf 'build complete\\n'",
            group: "build",
          },
          {
            label: "IDE task",
            type: "custom-provider",
            command: "unavailable",
          },
        ],
      },
      null,
      2,
    ),
);
for (const args of [
  ["init", "-b", "main"],
  ["add", "."],
  [
    "-c",
    "user.name=Oxbit Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "Fixture",
  ],
]) {
  const result = await runCommand("git", args, { cwd: root });
  if (result.exitCode) throw new Error(result.stderr);
}
await fs.mkdir("evidence/tasks", { recursive: true });
await fs.writeFile(
  "evidence/tasks/browser-workspace.json",
  JSON.stringify({ root, dir }),
);
const runtime = await createRuntime({
  root,
  port: 9286,
  dataDir: path.join(dir, "runtime"),
  tasksHome: dir,
  pairingCode: "oxbit-tasks-test",
  webRoot: path.resolve("apps/web/dist"),
});
let closing = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    void runtime.close().finally(async () => {
      await fs.rm(dir, { recursive: true, force: true });
      process.exit(0);
    });
  });
console.log(`Tasks browser fixture listening on ${runtime.port}`);
