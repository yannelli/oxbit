import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
if (process.platform !== "linux")
  throw new Error(
    "This installed-artifact smoke harness targets Linux; macOS acceptance uses the native app UI",
  );
const executable = path.resolve(
  process.argv.slice(2).find((argument) => argument !== "--") ||
    "/usr/bin/oxbit-desktop",
);
// Optional host emulator for local cross-architecture acceptance. Native CI
// leaves this unset and launches the artifact directly.
const runner = process.env.OXBIT_SMOKE_RUNNER
  ? path.resolve(process.env.OXBIT_SMOKE_RUNNER)
  : undefined;
const directory = await fs.mkdtemp(
  path.join(os.tmpdir(), "Oxbit installed café "),
);
const project = path.join(directory, "Project 项目");
const home = path.join(directory, "home");
const data = path.join(directory, "data");
await fs.mkdir(project);
await fs.mkdir(home);
await fs.writeFile(
  path.join(project, "hello.ts"),
  "export const installed = true;\n",
);
const env = {
  PATH: "/usr/bin:/bin",
  HOME: home,
  XDG_DATA_HOME: data,
  XDG_CONFIG_HOME: path.join(directory, "config"),
  SHELL: "/bin/sh",
  LANG: "C.UTF-8",
};
for (const name of [
  "DISPLAY",
  "XAUTHORITY",
  "WAYLAND_DISPLAY",
  "GDK_BACKEND",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
  "APPIMAGE_EXTRACT_AND_RUN",
])
  if (process.env[name]) env[name] = process.env[name];
const child = spawn(
  runner || executable,
  runner ? [executable, project] : [project],
  {
    cwd: home,
    env,
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
  },
);
let errors = "";
child.stderr.on("data", (bytes) => {
  errors = (errors + bytes.toString()).slice(-3000);
});
const exited = new Promise((resolve) => child.once("exit", resolve));
let failure;
child.once("error", (error) => {
  failure = error;
});
try {
  const deadline = Date.now() + 90000;
  let session;
  for (;;) {
    if (failure) throw failure;
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(
        "Installed app exited before opening its workbench: " + errors,
      );
    try {
      session = JSON.parse(
        await fs.readFile(
          path.join(data, "com.yannelli.oxbit/session.json"),
          "utf8",
        ),
      );
      const item = Object.values(session.projects).find(
        (p) => p.path === project,
      );
      if (
        item &&
        (
          await fs.readFile(
            path.join(data, "com.yannelli.oxbit/projects", item.key, "ui.json"),
            "utf8",
          )
        ).includes("hello.ts")
      )
        break;
    } catch {
      /* Wait for native startup and the first persisted document/layout. */
    }
    if (Date.now() > deadline)
      throw new Error(
        "Installed workbench did not persist its opened document: " + errors,
      );
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.equal(Object.keys(session.projects).length, 1);
  assert.equal(
    await fs.readFile(path.join(project, "hello.ts"), "utf8"),
    "export const installed = true;\n",
  );
  console.log(
    JSON.stringify(
      {
        status: "passed",
        executable,
        runner,
        scope:
          "Installed production WebView opened and persisted a real project using application resources and a minimal environment",
        systemTools: await Promise.all(
          ["node", "bun", "git", "gh"].map(async (name) => ({
            name,
            present: await fs.access("/usr/bin/" + name).then(
              () => true,
              () => false,
            ),
          })),
        ),
      },
      null,
      2,
    ),
  );
} finally {
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    /* The application already exited. */
  }
  await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
  if (child.exitCode === null && child.signalCode === null)
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      /* Already exited. */
    }
  await fs.rm(directory, { recursive: true, force: true });
}
