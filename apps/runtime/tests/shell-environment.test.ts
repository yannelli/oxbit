import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loginShellEnvironment, parseShellEnvironment } from "../src/shell-environment.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

async function fakeShell(body: string) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "oxbit-shell-env-"));
  directories.push(directory);
  const shell = path.join(directory, "bash");
  await fs.writeFile(shell, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return { directory, shell };
}

describe("login shell environment", () => {
  it("reads the environment between the markers and drops shell bookkeeping", () => {
    const output = "banner\nmark" + ["PATH=/opt/nvm/bin:/usr/bin", "MULTI=a=b\nc", "PWD=/tmp", "SHLVL=2", "_=/usr/bin/env", "bad-key=1", ""].join("\0") + "mark\ntrailer";
    expect(parseShellEnvironment(output, "mark")).toEqual({ PATH: "/opt/nvm/bin:/usr/bin", MULTI: "a=b\nc" });
    expect(parseShellEnvironment("no markers", "mark")).toBeUndefined();
  });

  it("runs the terminal shell as a login and interactive shell and keeps launch credentials", async () => {
    const { directory, shell } = await fakeShell([
      'echo "profile banner"',
      '[ "$1 $2 $3" = "-l -i -c" ] || exit 3',
      'export PATH="/opt/nvm/bin:$PATH" SSH_AUTH_SOCK=/shell/agent SAW_MARKER="$OXBIT_RESOLVING_ENVIRONMENT"',
      'exec /bin/sh -c "$4"',
    ].join("\n"));
    const env = await loginShellEnvironment(directory, { SHELL: shell, PATH: "/usr/bin:/bin", SSH_AUTH_SOCK: "/launch/agent" }, "linux");
    expect(env.PATH).toBe("/opt/nvm/bin:/usr/bin:/bin");
    expect(env.SSH_AUTH_SOCK).toBe("/launch/agent");
    expect(env.SAW_MARKER).toBe("1");
    expect(env.OXBIT_RESOLVING_ENVIRONMENT).toBeUndefined();
  });

  it("keeps the inherited environment when the shell fails or hangs", async () => {
    const inherited = { PATH: "/usr/bin:/bin" };
    const failing = await fakeShell("exit 1");
    expect(await loginShellEnvironment(failing.directory, { ...inherited, SHELL: failing.shell }, "linux"))
      .toEqual({ ...inherited, SHELL: failing.shell });
    const hanging = await fakeShell("exec sleep 30");
    const started = Date.now();
    expect(await loginShellEnvironment(hanging.directory, { ...inherited, SHELL: hanging.shell }, "linux", 200))
      .toEqual({ ...inherited, SHELL: hanging.shell });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(await loginShellEnvironment(hanging.directory, inherited, "win32")).toBe(inherited);
  });
});
