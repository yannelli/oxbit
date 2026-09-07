import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import { Processes } from "../src/processes.js";
import { resolveTerminalShell } from "../src/terminal-shell.js";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, userInfo: vi.fn(actual.userInfo) };
});

function accountShell(shell: string | null) {
  vi.mocked(userInfo).mockReturnValue({
    username: "terminal-test", uid: 1000, gid: 1000,
    homedir: "/terminal-test", shell,
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

describe("terminal shell selection", () => {
  it.each(["/bin/zsh", "/bin/bash", "/opt/custom shells/fish"])(
    "prefers the inherited shell %s over the account shell",
    (shell) => {
      accountShell("/bin/sh");
      expect(resolveTerminalShell({ SHELL: shell }, "linux").shell).toBe(shell);
      expect(userInfo).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, ""])("uses the account shell when SHELL is %s", (value) => {
    accountShell("/opt/homebrew/bin/zsh");
    expect(resolveTerminalShell({ SHELL: value }, "darwin").shell)
      .toBe("/opt/homebrew/bin/zsh");
  });

  it.each(["darwin", "linux"] as const)(
    "uses the %s fallback when account lookup is unavailable",
    (platform) => {
      vi.mocked(userInfo).mockImplementation(() => { throw new Error("No user entry"); });
      expect(resolveTerminalShell({}, platform).shell)
        .toBe(platform === "darwin" ? "/bin/zsh" : "/bin/bash");
      accountShell(null);
      expect(resolveTerminalShell({}, platform).shell)
        .toBe(platform === "darwin" ? "/bin/zsh" : "/bin/bash");
    },
  );

  it("keeps native startup options for PowerShell and custom shells", () => {
    expect(resolveTerminalShell({}, "win32"))
      .toEqual({ shell: "powershell.exe", args: [] });
    const shell = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
    expect(resolveTerminalShell({ SHELL: shell }, "win32"))
      .toEqual({ shell, args: [] });
    expect(resolveTerminalShell({ SHELL: "/opt/custom-shell" }, "linux"))
      .toEqual({ shell: "/opt/custom-shell", args: [] });
    expect(userInfo).not.toHaveBeenCalled();
  });

  it.each([
    ["/opt/homebrew/bin/fish", "darwin"],
    ["C:\\Program Files\\Git\\bin\\bash.exe", "win32"],
  ] as const)("loads login configuration for %s", (shell, platform) => {
    expect(resolveTerminalShell({ SHELL: shell }, platform))
      .toEqual({ shell, args: ["-l", "-i"] });
  });
});

for (const shell of ["/bin/zsh", "/bin/bash"]) {
  describe.skipIf(process.platform === "win32" || !existsSync(shell))(
    `real ${shell} terminal startup`,
    () => {
      it.each(["environment", "account"] as const)(
        "loads profiles and inherits the environment with the %s shell",
        async (source) => {
          const directory = await fs.mkdtemp(path.join(tmpdir(), "oxbit-shell-"));
          const profileDirectory = path.join(directory, "profile");
          const workspace = path.join(directory, "workspace");
          const binDirectory = path.join(directory, "startup-bin");
          let processes: Processes | undefined;
          try {
            await Promise.all([profileDirectory, workspace, binDirectory]
              .map((entry) => fs.mkdir(entry)));
            const profile = 'export OXBIT_LOGIN_PROFILE=loaded\nexport PATH="$OXBIT_TEST_BIN:$PATH"\n';
            const rc = "export OXBIT_INTERACTIVE_RC=loaded\nPS1='oxbit-test> '\n";
            await Promise.all([
              fs.writeFile(path.join(profileDirectory, ".zprofile"), profile),
              fs.writeFile(path.join(profileDirectory, ".zshrc"), rc),
              fs.writeFile(path.join(profileDirectory, ".bash_profile"),
                profile + '. "$HOME/.bashrc"\n'),
              fs.writeFile(path.join(profileDirectory, ".bashrc"), rc),
              fs.writeFile(path.join(binDirectory, "oxbit-startup-command"),
                `#!${shell}\nprintf '%s\\n' OXBIT_STARTUP_COMMAND_OK\n`, { mode: 0o700 }),
            ]);
            vi.stubEnv("SHELL", source === "environment" ? shell : undefined);
            vi.stubEnv("HOME", profileDirectory);
            vi.stubEnv("ZDOTDIR", profileDirectory);
            vi.stubEnv("OXBIT_TEST_BIN", binDirectory);
            vi.stubEnv("OXBIT_INHERITED", "from-runtime");
            vi.stubEnv("OXBIT_LOGIN_PROFILE", undefined);
            vi.stubEnv("OXBIT_INTERACTIVE_RC", undefined);
            accountShell(source === "account" ? shell : "/bin/sh");

            let output = "";
            processes = new Processes(workspace, (event) => {
              if (event.event === "terminal.data") output += event.params.data;
            });
            const session = processes.create("owner", "connection", 90, 25);
            // The marker is assembled by printf, so input echo cannot satisfy the assertion.
            const version = shell.endsWith("zsh") ? "$ZSH_VERSION" : "$BASH_VERSION";
            processes.input(session.id, "owner", [
              `printf '\\nOXBIT_%s|%s|%s|%s|%s|%s|%s|%s|%s\\n' SHELL "$SHELL" "${version}" "$OXBIT_INHERITED" "$OXBIT_LOGIN_PROFILE" "$OXBIT_INTERACTIVE_RC" "$-" "$TERM" "$PWD"`,
              "oxbit-startup-command",
              "exit",
              "",
            ].join("\r"));
            await vi.waitFor(() => {
              expect(processes!.list("owner")[0].exitCode).toBe(0);
            }, { timeout: 10000 });
            const result = output.split(/\r?\n/).find((line) => line.startsWith("OXBIT_SHELL|"));
            expect(result).toBeDefined();
            const fields = result!.split("|");
            expect(fields[1]).toBe(shell);
            expect(fields[2]).toMatch(/^\d+\./);
            expect(fields.slice(3, 6)).toEqual(["from-runtime", "loaded", "loaded"]);
            expect(fields[6]).toContain("i");
            expect(fields[7]).toBe("xterm-256color");
            expect(await fs.realpath(fields[8])).toBe(await fs.realpath(workspace));
            expect(output).toContain("OXBIT_STARTUP_COMMAND_OK");
          } finally {
            processes?.close();
            await fs.rm(directory, { recursive: true, force: true });
          }
        },
      );
    },
  );
}
