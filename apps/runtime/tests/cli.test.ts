import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { DEFAULT_HOST, parse, resolveTarget } from "../src/cli.js";
import {
  browserCommand,
  dataDirFor,
  launchUrl,
  liveDaemon,
  recordFile,
  running,
  writeRecord,
  type Daemon,
} from "../src/daemon.js";

let root = "";
const env = { HOME: os.homedir() };
const daemon: Daemon = {
  pid: process.pid,
  host: "127.0.0.1",
  port: 9277,
  pairingCode: "code",
  root: "/workspace",
  startedAt: 0,
};

beforeAll(async () => {
  root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "oxbit-cli-")),
  );
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.mkdir(path.join(root, "elsewhere"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "hello.ts"), "export const a = 1;");
});
afterAll(() => fs.rm(root, { recursive: true, force: true }));

describe("argument parsing", () => {
  it("defaults to the current directory, port and loopback host", () => {
    expect(parse([], env)).toEqual({
      target: ".",
      port: undefined,
      host: DEFAULT_HOST,
      open: true,
      foreground: false,
      action: "open",
    });
  });

  it("takes the workspace, port and host from the environment", () => {
    expect(
      parse([], {
        ...env,
        OXBIT_WORKSPACE: "/w",
        PORT: "9278",
        HOST: "0.0.0.0",
      }),
    ).toMatchObject({ target: "/w", port: 9278, host: "0.0.0.0" });
  });

  it("prefers arguments over the environment", () => {
    expect(
      parse(["--port", "9300", "--host", "::1", "/a"], {
        ...env,
        PORT: "9278",
        HOST: "0.0.0.0",
        OXBIT_WORKSPACE: "/w",
      }),
    ).toMatchObject({ target: "/a", port: 9300, host: "::1" });
  });

  it("reads the remaining flags", () => {
    expect(parse(["--no-open", "-f"], env)).toMatchObject({
      open: false,
      foreground: true,
    });
    expect(parse(["--stop"], env)).toMatchObject({ action: "stop" });
    expect(parse(["--status"], env)).toMatchObject({ action: "status" });
    expect(parse(["-h"], env)).toMatchObject({ action: "help" });
    expect(parse(["-v"], env)).toMatchObject({ action: "version" });
  });

  it("rejects a port that is not a whole number in range", () => {
    for (const value of ["abc", "1.5", "-1", "70000"])
      expect(parse(["--port", value], env)).toHaveProperty("error");
    expect(parse([], { ...env, PORT: "abc" })).toHaveProperty("error");
  });

  it("rejects unknown flags and extra paths", () => {
    expect(parse(["--nope"], env)).toHaveProperty("error");
    expect(parse(["/a", "/b"], env)).toEqual({
      error: "Expected at most one path, received 2",
    });
  });
});

describe("target resolution", () => {
  it("uses a directory as the workspace with no file to focus", async () => {
    expect(await resolveTarget(".", root)).toEqual({ root });
  });

  it("keeps the current directory as the workspace for a file inside it", async () => {
    expect(await resolveTarget("src/hello.ts", root)).toEqual({
      root,
      file: "src/hello.ts",
    });
  });

  it("falls back to the containing directory for a file outside", async () => {
    expect(
      await resolveTarget(
        path.join(root, "src", "hello.ts"),
        path.join(root, "elsewhere"),
      ),
    ).toEqual({ root: path.join(root, "src"), file: "hello.ts" });
  });

  it("reports a path that does not exist", async () => {
    await expect(resolveTarget("missing.ts", root)).rejects.toThrow(
      `No such file or directory: ${path.join(root, "missing.ts")}`,
    );
  });
});

describe("launch url", () => {
  it("carries the pairing code alone when no file was named", () => {
    expect(launchUrl(daemon)).toBe("http://127.0.0.1:9277/#pair=code");
  });

  it("encodes the file to focus", () => {
    expect(launchUrl(daemon, "src/a b.ts")).toBe(
      "http://127.0.0.1:9277/#pair=code&open=src%2Fa+b.ts",
    );
    expect(
      new URLSearchParams(launchUrl(daemon, "src/a b.ts").split("#")[1]!).get(
        "open",
      ),
    ).toBe("src/a b.ts");
  });
});

describe("browser command", () => {
  it("uses the opener each platform ships", () => {
    expect(browserCommand("u", "darwin")).toEqual({
      command: "open",
      args: ["u"],
    });
    expect(browserCommand("u", "win32")).toEqual({
      command: "cmd",
      args: ["/c", "start", "", "u"],
    });
    expect(browserCommand("u", "linux")).toEqual({
      command: "xdg-open",
      args: ["u"],
    });
  });
});

describe("daemon record", () => {
  it("derives the data directory from the workspace or the environment", () => {
    expect(dataDirFor("/workspace", { ...env, OXBIT_DATA_DIR: "/d" })).toBe(
      "/d",
    );
    const derived = dataDirFor("/workspace", env);
    expect(derived).toBe(dataDirFor("/workspace", env));
    expect(derived).not.toBe(dataDirFor("/other", env));
  });

  it("keeps the pairing code owner readable", async () => {
    const dataDir = path.join(root, "data");
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    await writeRecord(dataDir, daemon);
    const stats = await fs.stat(recordFile(dataDir));
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it("reports a record whose process is gone as not live", async () => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await new Promise((resolve) => child.on("exit", resolve));
    expect(running(child.pid!)).toBe(false);
    const dataDir = path.join(root, "stale");
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    await writeRecord(dataDir, { ...daemon, pid: child.pid! });
    expect(await liveDaemon(dataDir)).toBeUndefined();
  });

  it("reports a missing or malformed record as not live", async () => {
    const dataDir = path.join(root, "empty");
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    expect(await liveDaemon(dataDir)).toBeUndefined();
    await fs.writeFile(recordFile(dataDir), "{ not json");
    expect(await liveDaemon(dataDir)).toBeUndefined();
    await fs.writeFile(recordFile(dataDir), JSON.stringify({ pid: 1 }));
    expect(await liveDaemon(dataDir)).toBeUndefined();
  });
});
