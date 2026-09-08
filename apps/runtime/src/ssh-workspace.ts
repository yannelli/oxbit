import * as fs from "node:fs/promises";
import path from "node:path";

export class RemoteWorkspaceBusy extends Error {
  constructor() {
    super(
      "This remote folder is already open in another SSH session. Close that session, or wait for its connection lease to expire, then retry.",
    );
  }
}

/** One writer for the persisted runtime state of a canonical remote root. */
export async function acquireRemoteWorkspace(dataDir: string) {
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  const lock = path.join(dataDir, "ssh-owner");
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await fs.mkdir(lock, { mode: 0o700 });
      await fs.writeFile(path.join(lock, "pid"), String(process.pid), {
        mode: 0o600,
      });
      return () => fs.rm(lock, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const pid = Number(await fs.readFile(path.join(lock, "pid"), "utf8"));
        if (Number.isInteger(pid) && pid > 1) {
          try {
            process.kill(pid, 0);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ESRCH") {
              await fs.rm(lock, { recursive: true, force: true });
              continue;
            }
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          // A crash between mkdir and writing the PID must not block the folder forever.
          const info = await fs.stat(lock).catch(() => undefined);
          if (!info || Date.now() - info.mtimeMs > 240000) {
            await fs.rm(lock, { recursive: true, force: true });
            continue;
          }
        }
      }
      throw new RemoteWorkspaceBusy();
    }
  }
  throw new RemoteWorkspaceBusy();
}
