import type { ChildProcess } from "node:child_process";
export function killProcess(child: ChildProcess) {
  if (child.exitCode !== null) return;
  try {
    if (process.platform !== "win32" && child.pid)
      process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  const timer = setTimeout(() => {
    try {
      if (process.platform !== "win32" && child.pid)
        process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch {
      /* Process has exited. */
    }
  }, 1500);
  timer.unref();
}
