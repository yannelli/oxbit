import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRuntime } from "../src/runtime.js";
import { lanOrigins, lanUrl, localHost } from "../src/lan.js";
import { launchUrl } from "../src/daemon.js";

const entry = (address: string, family: "IPv4" | "IPv6", internal = false) =>
  ({ address, family, internal, netmask: "", mac: "", cidr: null, ...(family === "IPv6" ? { scopeid: 0 } : {}) }) as os.NetworkInterfaceInfo;
const interfaces = {
  lo0: [entry("127.0.0.1", "IPv4", true), entry("::1", "IPv6", true)],
  en0: [entry("192.168.1.20", "IPv4"), entry("fe80::1%en0", "IPv6"), entry("2001:db8::5", "IPv6")],
};

describe("LAN origins", () => {
  it("allows every non-internal address and the .local host name", () => {
    expect(lanOrigins(4100, interfaces, "studio.example.internal", "Studio-2").at(-1)).toBe("http://Studio-2.local:4100");
    expect(lanOrigins(4100, interfaces, "studio.example.internal", "")).toEqual([
      "http://192.168.1.20:4100",
      "http://[fe80::1]:4100",
      "http://[2001:db8::5]:4100",
      "http://studio.local:4100",
    ]);
    expect(lanUrl(4100, interfaces)).toBe("http://192.168.1.20:4100");
    expect(lanUrl(4100, { lo0: interfaces.lo0 })).toBeUndefined();
  });

  it("probes and opens wildcard runtimes on loopback", () => {
    expect(localHost("0.0.0.0")).toBe("127.0.0.1");
    expect(localHost("::")).toBe("127.0.0.1");
    expect(launchUrl({ pid: 1, host: "0.0.0.0", port: 4100, pairingCode: "c", root: "/w", startedAt: 0 })).toBe("http://127.0.0.1:4100/#pair=c");
  });

  it("accepts LAN and iOS origins only when bound to every interface", async () => {
    const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "oxbit-lan-"));
    await fs.mkdir(path.join(directory, "workspace"));
    const start = (host: string) => createRuntime({
      root: path.join(directory, "workspace"), host, tasksHome: directory,
      dataDir: path.join(directory, "state"), projectsDir: path.join(directory, "projects"),
      settingsFile: path.join(directory, "settings.json"),
    });
    const status = (port: number, origin: string) =>
      fetch(`http://127.0.0.1:${port}/api/health`, { headers: { Origin: origin } }).then((response) => response.status);
    const lan = await start("0.0.0.0");
    try {
      const [origin] = lanOrigins(lan.port);
      expect(await status(lan.port, origin!)).toBe(200);
      expect(await status(lan.port, "tauri://localhost")).toBe(200);
      expect(await status(lan.port, `http://${os.hostname().split(".")[0]}.local:${lan.port}`)).toBe(200);
      expect(await status(lan.port, "http://evil.example")).toBe(403);
    } finally {
      await lan.close();
    }
    const loopback = await start("127.0.0.1");
    try {
      expect(await status(loopback.port, lanOrigins(loopback.port).at(-1)!)).toBe(403);
    } finally {
      await loopback.close();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
