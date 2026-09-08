import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
if (process.platform !== "linux")
  throw new Error("Wayland acceptance requires Ubuntu 24.04");
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "oxbit-wayland-"));
await fs.chmod(directory, 0o700);
const socket = "wayland-oxbit";
const env = {
  ...process.env,
  XDG_RUNTIME_DIR: directory,
  WAYLAND_DISPLAY: socket,
  GDK_BACKEND: "wayland",
};
// Keep the outer X11 display available for clipboard interoperability, as on Ubuntu's desktop.
const weston = spawn(
  "weston",
  [
    "--backend=headless",
    "--renderer=pixman",
    "--no-config",
    "--idle-time=0",
    `--socket=${socket}`,
  ],
  { env, stdio: ["ignore", "ignore", "inherit"] },
);
let spawnError;
weston.on("error", (error) => {
  spawnError = error;
});
let test;
try {
  const deadline = Date.now() + 15000;
  for (;;) {
    if (spawnError) throw spawnError;
    if (weston.exitCode !== null)
      throw new Error("Weston exited before creating its Wayland socket");
    try {
      await fs.access(path.join(directory, socket));
      break;
    } catch {
      /* Wait for compositor readiness. */
    }
    if (Date.now() > deadline) throw new Error("Weston readiness timed out");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  test = spawn("pnpm", ["desktop:test:native"], { env, stdio: "inherit" });
  process.exitCode = await new Promise((resolve, reject) => {
    test.once("exit", (code) => resolve(code ?? 1));
    test.once("error", reject);
  });
} finally {
  test?.kill("SIGTERM");
  weston.kill("SIGTERM");
  await fs.rm(directory, { recursive: true, force: true });
}
