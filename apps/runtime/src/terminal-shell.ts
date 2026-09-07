import { userInfo } from "node:os";
import path from "node:path";

export function resolveTerminalShell(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
) {
  let shell = env.SHELL;
  if (!shell && platform !== "win32") {
    try {
      // GUI and service launches may omit SHELL even when the account has one.
      shell = userInfo().shell || undefined;
    } catch {
      // Minimal containers may not have an entry for the runtime's user.
    }
  }
  shell ||= platform === "win32"
    ? "powershell.exe"
    : platform === "darwin"
      ? "/bin/zsh"
      : "/bin/bash";

  const name = (platform === "win32" ? path.win32 : path.posix)
    .basename(shell).toLowerCase().replace(/\.exe$/, "");
  // Load login profiles as well as interactive configuration in these shells.
  // Other shells keep their native startup options (including PowerShell profiles).
  const args = ["bash", "zsh", "fish"].includes(name) ? ["-l", "-i"] : [];
  return { shell, args };
}
