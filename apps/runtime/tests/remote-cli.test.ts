import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateX25519KeyPair, parseOfferLink } from "@oxbit/sdk/tunnel";
import { run, USAGE } from "../src/cli.js";
import { parseRemote, runRemote, serviceSpec, type RemoteContext } from "../src/remote/commands.js";
import { connectDevice } from "./remote-device.js";
import { RemoteHost, type HostOptions } from "../src/remote/host.js";
import { launchdPlist, serviceManager, systemdUnit, type ServiceManager, type ServiceSpec } from "../src/remote/service.js";
import { readDevices, remotePaths } from "../src/remote/state.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});
async function temp() {
  // Short prefix: the control socket path must fit in 104 bytes on macOS.
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "oxr-")));
  cleanup.push(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

describe("oxbit remote arguments", () => {
  it("parses each command and its flags", () => {
    expect(parseRemote(["status"], {})).toEqual({ command: "status", json: false, link: false, service: true, pair: true });
    expect(parseRemote(["pair", "--link", "--json"], {})).toMatchObject({ command: "pair", link: true, json: true });
    expect(parseRemote(["enable", "--no-service", "--no-pair"], {})).toMatchObject({ command: "enable", service: false, pair: false });
    expect(parseRemote(["enable"], { OXBIT_REMOTE_SERVICE: "0" })).toMatchObject({ service: false });
    expect(parseRemote(["revoke", "iPad"], {})).toMatchObject({ command: "revoke", device: "iPad" });
    expect(parseRemote([], {})).toMatchObject({ command: "help" });
    expect(parseRemote(["status", "-h"], {})).toMatchObject({ command: "help" });
    for (const argv of [["bogus"], ["revoke"], ["revoke", "a", "b"], ["status", "x"], ["status", "--link"], ["pair", "--no-service"], ["serve", "--json"], ["pair", "--nope"]])
      expect(parseRemote(argv, {})).toHaveProperty("error");
  });

  it("routes oxbit remote from the runtime CLI and lists the commands in its usage", async () => {
    expect(USAGE).toContain("oxbit remote enable [--no-service] [--no-pair]");
    expect(USAGE).toContain("oxbit remote revoke <device>");
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(await run(["remote", "--help"])).toBe(0);
      expect(stdout).toHaveBeenCalledWith(expect.stringContaining("oxbit remote pair [--link]"));
      expect(await run(["remote", "bogus"])).toBe(2);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('Unknown remote command "bogus"'));
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });
});

describe("login item", () => {
  const spec: ServiceSpec = { program: ["/usr/local/bin/node", "/opt/oxbit/index.js", "remote", "serve"], env: { PATH: "/usr/bin:/bin", OXBIT_RELAY: "wss://r.example/a&b" }, log: "/Users/me/.oxbit/remote/remote.log" };

  it("writes the launchd agent and bootstraps it in the GUI domain", async () => {
    expect(launchdPlist(spec)).toContain("<string>dev.oxbit.remote</string>");
    expect(launchdPlist(spec)).toContain("<string>/usr/local/bin/node</string>\n    <string>/opt/oxbit/index.js</string>\n    <string>remote</string>\n    <string>serve</string>");
    expect(launchdPlist(spec)).toContain("<key>OXBIT_RELAY</key>\n    <string>wss://r.example/a&amp;b</string>");
    expect(launchdPlist(spec)).toContain("<key>StandardErrorPath</key>\n  <string>/Users/me/.oxbit/remote/remote.log</string>");
    const home = await temp();
    const calls: string[][] = [];
    const manager = serviceManager({ platform: "darwin", home, uid: 501, run: async (command, args) => (calls.push([command, ...args]), { code: 0, stderr: "" }) })!;
    expect(manager.file).toBe(path.join(home, "Library", "LaunchAgents", "dev.oxbit.remote.plist"));
    expect(await manager.installed()).toBe(false);
    await manager.install(spec);
    expect(await fs.readFile(manager.file, "utf8")).toBe(launchdPlist(spec));
    expect(await manager.current(spec)).toBe(true);
    expect(calls).toEqual([
      ["launchctl", "bootout", "gui/501/dev.oxbit.remote"],
      ["launchctl", "bootstrap", "gui/501", manager.file],
    ]);
    expect(await manager.uninstall()).toBe(true);
    expect(calls.at(-1)).toEqual(["launchctl", "bootout", "gui/501/dev.oxbit.remote"]);
    expect(await manager.installed()).toBe(false);
    expect(await manager.uninstall()).toBe(false);
    expect(calls).toHaveLength(3);
  });

  it("writes the systemd user unit and enables it", async () => {
    const unit = systemdUnit({ ...spec, env: { PATH: '/a b/"c"%d' } });
    expect(unit).toContain('ExecStart="/usr/local/bin/node" "/opt/oxbit/index.js" "remote" "serve"');
    expect(unit).toContain('Environment="PATH=/a b/\\"c\\"%%d"');
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("WantedBy=default.target");
    const home = await temp();
    const calls: string[][] = [];
    const manager = serviceManager({ platform: "linux", home, env: {}, run: async (command, args) => (calls.push([command, ...args]), { code: 0, stderr: "" }) })!;
    expect(manager.file).toBe(path.join(home, ".config", "systemd", "user", "oxbit-remote.service"));
    await manager.install(spec);
    await manager.install(spec);
    expect(calls).toEqual([
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "--now", "oxbit-remote.service"],
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "--now", "oxbit-remote.service"],
      ["systemctl", "--user", "restart", "oxbit-remote.service"],
    ]);
    await manager.uninstall();
    expect(calls.slice(-2)).toEqual([
      ["systemctl", "--user", "disable", "--now", "oxbit-remote.service"],
      ["systemctl", "--user", "daemon-reload"],
    ]);
    expect(serviceManager({ platform: "win32", home })).toBeUndefined();
  });

  it("reports a failed bootstrap", async () => {
    const manager = serviceManager({ platform: "darwin", home: await temp(), uid: 501, run: async (_command, args) => ({ code: args[0] === "bootstrap" ? 5 : 0, stderr: "Input/output error" }) })!;
    await expect(manager.install(spec)).rejects.toThrow("launchctl bootstrap failed (5): Input/output error");
  });
});

async function harness(hostOptions: Partial<HostOptions> = {}) {
  const directory = await temp();
  const env = { OXBIT_REMOTE_DIR: path.join(directory, "r"), PATH: "/usr/bin:/bin" };
  const paths = remotePaths(env);
  const home = path.join(directory, "home");
  await fs.mkdir(home);
  const lines: string[] = [];
  const errors: string[] = [];
  const startHost = async () => {
    const host = await RemoteHost.start({
      paths, env, home, name: "Studio Mac", advertise: false, relay: false, lanHost: "127.0.0.1",
      launcher: { ensure: () => Promise.reject(new Error("unused")), list: async () => [] },
      ...hostOptions,
    });
    cleanup.push(() => host.close());
    return host;
  };
  const context = (service: ServiceManager | null = null): RemoteContext => ({
    entry: "/opt/oxbit/index.js", startRuntime: () => Promise.reject(new Error("unused")), env, home, service,
    stdout: (text) => lines.push(...text.trimEnd().split("\n")), stderr: (text) => errors.push(text), hostWaitMs: 2000,
  });
  const json = () => lines.splice(0).map((line) => JSON.parse(line));
  return { env, paths, home, lines, errors, startHost, context, json };
}

describe("oxbit remote commands", () => {
  it("reports a stopped host, pairs a device with --json, and manages devices", async () => {
    const { paths, context, json, lines, errors, startHost } = await harness();
    expect(await runRemote(["pair"], context())).toBe(1);
    expect(errors.splice(0)).toEqual(['The remote access host is not running. Run "oxbit remote enable", or "oxbit remote serve" when the login item is off.\n']);
    expect(await runRemote(["pair", "--json"], context())).toBe(1);
    expect(json()).toEqual([{ error: { code: "HOST_NOT_RUNNING", message: expect.stringContaining("not running") } }]);
    expect(await runRemote(["status", "--json"], context())).toBe(1);
    expect(json()).toEqual([{ enabled: false, running: false, hostId: null, name: expect.any(String), relay: { url: "wss://relay.oxbit.dev", connected: false, state: "off" }, lan: { port: null, addresses: [] }, devices: [] }]);
    expect(await runRemote(["enable", "--no-service", "--json"], context())).toBe(0);
    const [{ hostId }] = json();
    expect(hostId).toMatch(/^[A-Za-z0-9_-]{22}$/);

    const host = await startHost();
    expect(await runRemote(["enable", "--no-service", "--no-pair", "--json"], context())).toBe(0);
    expect(json()).toEqual([{ enabled: false, running: true, hostId, name: "Studio Mac" }]);
    const pairing = runRemote(["pair", "--json"], context());
    await expect.poll(() => lines.length).toBe(1);
    const [first] = json();
    expect(first).toEqual({ link: expect.stringMatching(/^https:\/\/oxbit\.dev\/c#o=/), expiresAt: expect.any(Number), host: { id: hostId, name: "Studio Mac" } });
    const device = await connectDevice(`ws://127.0.0.1:${host.status().lan.port}/v1/connect`, { deviceKey: await generateX25519KeyPair(), name: "iPhone", offer: await parseOfferLink(first.link) });
    cleanup.push(async () => device.socket.close());
    await device.control.request("host.info");
    expect(await pairing).toBe(0);
    expect(json()).toEqual([{ paired: { id: expect.any(String), name: "iPhone" } }]);

    expect(await runRemote(["status", "--json"], context())).toBe(0);
    expect(json()).toEqual([{
      enabled: false, running: true, hostId, name: "Studio Mac",
      relay: { url: "wss://relay.oxbit.dev", connected: false, state: "off" },
      lan: { port: host.status().lan.port, addresses: [`127.0.0.1:${host.status().lan.port}`] },
      devices: [{ id: expect.any(String), name: "iPhone", pairedAt: expect.any(Number), lastSeen: expect.any(Number) }],
    }]);
    expect(await runRemote(["status"], context())).toBe(0);
    expect(lines.splice(0)).toEqual([
      "Remote access: login item not installed",
      `Host: "Studio Mac" ${hostId}, running (pid ${process.pid})`,
      "Relay: wss://relay.oxbit.dev, off",
      `LAN: 127.0.0.1:${host.status().lan.port}`,
      "Devices: 1 paired, 1 connected",
    ]);
    expect(await runRemote(["devices"], context())).toBe(0);
    expect(lines.splice(0)).toEqual([expect.stringMatching(/^iPhone {2}\S{10} {2}paired .+ {2}connected$/)]);
    expect(await runRemote(["revoke", "nobody", "--json"], context())).toBe(1);
    expect(json()).toEqual([{ error: { code: "NOT_FOUND", message: 'No paired device matches "nobody"' } }]);
    expect(await runRemote(["revoke", "iphone", "--json"], context())).toBe(0);
    expect(json()).toEqual([{ revoked: { id: expect.any(String), name: "iPhone" } }]);
    expect(await device.closed).toEqual({ code: 4403, reason: "revoked" });
    expect(await runRemote(["devices", "--json"], context())).toBe(0);
    expect(json()).toEqual([{ devices: [] }]);

    expect(await runRemote(["reset", "--json"], context())).toBe(0);
    const [{ hostId: fresh }] = json();
    expect(fresh).not.toBe(hostId);
    expect(host.id).toBe(fresh);
    expect(await runRemote(["disable", "--json"], context())).toBe(0);
    expect(json()).toEqual([{ enabled: false, running: false }]);
    await expect.poll(async () => (await fs.readdir(paths.dir)).includes("ctl.sock")).toBe(false);
  });

  it("prints a human pairing link and a timeout line when nobody pairs", async () => {
    const { context, lines, startHost } = await harness({ offerTtlMs: 50 });
    await startHost();
    expect(await runRemote(["pair", "--link"], context())).toBe(1);
    expect(lines).toEqual([
      'Pair a device with "Studio Mac".',
      expect.stringMatching(/^https:\/\/oxbit\.dev\/c#o=[A-Za-z0-9_-]+$/),
      expect.stringMatching(/^Open the link on the device or paste it into Oxbit's Runtime page\. It works once and expires at .+\.$/),
      'The pairing link expired before a device used it. Run "oxbit remote pair" for a new one.',
    ]);
  });

  it("installs the login item on enable, waits for the host, and removes it on disable", async () => {
    const { env, paths, context, json, startHost } = await harness();
    let installed: ServiceSpec | undefined;
    const service: ServiceManager = {
      kind: "launchd",
      file: "/fake/dev.oxbit.remote.plist",
      current: async (spec) => JSON.stringify(spec) === JSON.stringify(installed),
      installed: async () => installed !== undefined,
      install: async (spec) => {
        installed = spec;
        await startHost();
      },
      uninstall: async () => {
        const had = installed !== undefined;
        installed = undefined;
        return had;
      },
    };
    expect(await runRemote(["enable", "--no-pair", "--json"], context(service))).toBe(0);
    expect(json()).toEqual([{ enabled: true, running: true, hostId: expect.any(String), name: "Studio Mac" }]);
    expect(installed).toEqual(serviceSpec(paths, env, "/opt/oxbit/index.js"));
    expect(installed).toEqual({ program: [process.execPath, "/opt/oxbit/index.js", "remote", "serve"], env: { PATH: "/usr/bin:/bin", OXBIT_REMOTE_DIR: paths.dir }, log: paths.log });
    expect(await runRemote(["status", "--json"], context(service))).toBe(0);
    expect(json()[0]).toMatchObject({ enabled: true, running: true });
    expect(await runRemote(["disable", "--json"], context(service))).toBe(0);
    expect(json()).toEqual([{ enabled: false, running: false }]);
    expect(installed).toBeUndefined();
    expect(await readDevices(paths)).toEqual([]);
  });

  it("reports a host that never starts after install", async () => {
    const { context, errors } = await harness();
    const service = { kind: "launchd", file: "/fake", current: async () => false, installed: async () => true, install: async () => {}, uninstall: async () => true } as ServiceManager;
    expect(await runRemote(["enable"], { ...context(service), hostWaitMs: 300 })).toBe(1);
    expect(errors[0]).toMatch(/^The remote access host did not start within 0\.3s\. See .*remote\.log\n$/);
  });
});
