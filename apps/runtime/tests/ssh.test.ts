import { describe, expect, it } from "vitest";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  installScript,
  parseSshTarget,
  shellQuote,
  sshArguments,
} from "../src/ssh-target.js";
import { acquireRemoteWorkspace } from "../src/ssh-workspace.js";
const exec = promisify(execFile);

describe("SSH workspace boundary", () => {
  it("supports config aliases, ports, IPv6, home paths and encoded filenames", () => {
    expect(
      parseSshTarget("ssh://ryan@dev:2222/~/space%20and%20%27quote/file.ts"),
    ).toEqual({
      destination: "ryan@dev",
      port: 2222,
      path: "/~/space and 'quote/file.ts",
    });
    expect(parseSshTarget("ssh://user@[::1]:22/work").destination).toBe(
      "user@[::1]",
    );
    expect(parseSshTarget("ssh://dev/work/%24%28touch%20bad%29").path).toBe(
      "/work/$(touch bad)",
    );
  });
  it("rejects option injection, passwords, controls, malformed escaping and invalid ports", () => {
    for (const uri of [
      "ssh://-oProxyCommand=bad/x",
      "ssh://user:password@host/x",
      "ssh://host:0/x",
      "ssh://host:65536/x",
      "ssh://host:abc/x",
      "ssh://user@host x/x",
      "ssh://host/%00",
      "ssh://host/%0a",
      "ssh://host/%XX",
      "ssh://host",
      "https://host/x",
    ]) {
      expect(() => parseSshTarget(uri), uri).toThrow();
    }
  });
  it("retains host verification and isolates forwarding and process lifetime", () => {
    const args = sshArguments(
      parseSshTarget("ssh://host:2222/x"),
      "/private/control",
    );
    expect(args).toContain("StrictHostKeyChecking=yes");
    expect(args).toContain("BatchMode=yes");
    expect(args).toContain("ControlPersist=no");
    expect(args).toContain("-a");
    expect(args.slice(-2)).toEqual(["-p", "2222"]);
  });
  it("quotes shell metacharacters literally", async () => {
    const value = "a' b; $(echo unexpected) `whoami` \\ café";
    expect(
      (await exec("/bin/sh", ["-c", "printf '%s' " + shellQuote(value)]))
        .stdout,
    ).toBe(value);
  });
  it("protects shared runtime state and recovers an exited owner's lock", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oxbit-ssh-owner-"));
    try {
      const release = await acquireRemoteWorkspace(dir);
      await expect(acquireRemoteWorkspace(dir)).rejects.toThrow("already open");
      await release();
      await fs.mkdir(path.join(dir, "ssh-owner"));
      await fs.writeFile(path.join(dir, "ssh-owner/pid"), "2147483647");
      await (
        await acquireRemoteWorkspace(dir)
      )();
      expect(await fs.readdir(dir)).toEqual([]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
  it("replaces an owner with the same workspace key and refuses another key", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oxbit-ssh-takeover-"));
    const owner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    try {
      await new Promise((resolve) => owner.once("spawn", resolve));
      await fs.mkdir(path.join(dir, "ssh-owner"));
      await fs.writeFile(path.join(dir, "ssh-owner/pid"), String(owner.pid));
      await fs.writeFile(path.join(dir, "ssh-owner/workspace"), "a".repeat(64));
      await expect(acquireRemoteWorkspace(dir, "b".repeat(64))).rejects.toThrow("already open");
      expect(owner.exitCode).toBeNull();
      const exited = new Promise((resolve) => owner.once("exit", (_code, signal) => resolve(signal)));
      const release = await acquireRemoteWorkspace(dir, "a".repeat(64));
      expect(await exited).toBe("SIGTERM");
      expect(await fs.readFile(path.join(dir, "ssh-owner/pid"), "utf8")).toBe(String(process.pid));
      expect(await fs.readFile(path.join(dir, "ssh-owner/workspace"), "utf8")).toBe("a".repeat(64));
      await release();
    } finally {
      owner.kill("SIGKILL");
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
  it("rejects corrupted installs before extraction and reuses a completed version", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "oxbit-installer-test-"),
    );
    try {
      const payload = path.join(directory, "payload");
      await fs.mkdir(path.join(payload, "bin"), { recursive: true });
      await fs.writeFile(
        path.join(payload, "bin/node"),
        "#!/bin/sh\nexit 0\n",
        { mode: 0o755 },
      );
      await fs.writeFile(path.join(payload, "desktop.js"), "fixture");
      const archive = path.join(directory, "runtime.tar.gz");
      await exec("tar", ["-czf", archive, "-C", payload, "."]);
      const digest = createHash("sha256")
        .update(await fs.readFile(archive))
        .digest("hex");
      const run = (hash: string) =>
        exec(
          "/bin/sh",
          [
            "-c",
            `sh -c ${shellQuote(installScript(hash))} < ${shellQuote(archive)}`,
          ],
          { env: { ...process.env, HOME: directory } },
        );
      await expect(run("a".repeat(64))).rejects.toThrow();
      const base = path.join(directory, ".oxbit/remote/runtimes");
      expect(await fs.readdir(base)).toEqual([]);
      await Promise.all([run(digest), run(digest)]);
      expect(
        await fs.readFile(path.join(base, digest, "desktop.js"), "utf8"),
      ).toBe("fixture");
      await Promise.all([run(digest), run(digest)]);
      expect(await fs.readdir(base)).toEqual([digest]);
      expect(await fs.readdir(path.join(base, digest))).not.toContain(
        "runtime",
      );
      expect(() => installScript("../escape")).toThrow();
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
