import * as fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";

export const LAUNCHD_LABEL = "dev.oxbit.remote";
export const SYSTEMD_UNIT = "oxbit-remote.service";

/** What the login item runs. */
export interface ServiceSpec {
  program: string[];
  env: Record<string, string>;
  log: string;
}
export interface ServiceManager {
  readonly kind: "launchd" | "systemd";
  readonly file: string;
  /** True when the installed file already has this content. */
  current(spec: ServiceSpec): Promise<boolean>;
  installed(): Promise<boolean>;
  install(spec: ServiceSpec): Promise<void>;
  /** Stops the host and removes the item; false when none was installed. */
  uninstall(): Promise<boolean>;
}
export type Exec = (command: string, args: string[]) => Promise<{ code: number; stderr: string }>;

export const exec: Exec = (command, args) =>
  new Promise((resolve) => {
    execFile(command, args, { timeout: 30_000 }, (error, _stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === "number" ? Number((error as { code: number }).code) : 1) : 0;
      resolve({ code, stderr: String(stderr || (error?.message ?? "")).trim() });
    });
  });

const xml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function launchdPlist(spec: ServiceSpec): string {
  const strings = (values: string[]) => values.map((value) => `    <string>${xml(value)}</string>`).join("\n");
  const env = Object.entries(spec.env)
    .map(([key, value]) => `    <key>${xml(key)}</key>\n    <string>${xml(value)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${strings(spec.program)}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xml(spec.log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(spec.log)}</string>
</dict>
</plist>
`;
}

const quote = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;

export function systemdUnit(spec: ServiceSpec): string {
  const env = Object.entries(spec.env).map(([key, value]) => `Environment=${quote(`${key}=${value}`)}\n`);
  return `[Unit]
Description=Oxbit remote access host
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${spec.program.map(quote).join(" ")}
${env.join("")}Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

const read = (file: string) => fs.readFile(file, "utf8").catch(() => undefined);
const exists = (file: string) => fs.access(file).then(() => true, () => false);

async function check(run: Promise<{ code: number; stderr: string }>, what: string) {
  const result = await run;
  if (result.code !== 0) throw new Error(`${what} failed (${result.code})${result.stderr ? `: ${result.stderr}` : ""}`);
}

function launchd(home: string, uid: number, run: Exec): ServiceManager {
  const file = path.join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
  const domain = `gui/${uid}`;
  return {
    kind: "launchd",
    file,
    current: async (spec) => (await read(file)) === launchdPlist(spec),
    installed: () => exists(file),
    async install(spec) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, launchdPlist(spec), { mode: 0o644 });
      await run("launchctl", ["bootout", `${domain}/${LAUNCHD_LABEL}`]);
      let result = await run("launchctl", ["bootstrap", domain, file]);
      // bootstrap can fail with EIO while the previous instance is still being removed.
      for (let attempt = 0; result.code !== 0 && attempt < 3; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        result = await run("launchctl", ["bootstrap", domain, file]);
      }
      await check(Promise.resolve(result), "launchctl bootstrap");
    },
    async uninstall() {
      const had = await exists(file);
      if (had) await run("launchctl", ["bootout", `${domain}/${LAUNCHD_LABEL}`]);
      await fs.rm(file, { force: true });
      return had;
    },
  };
}

function systemd(configHome: string, run: Exec): ServiceManager {
  const file = path.join(configHome, "systemd", "user", SYSTEMD_UNIT);
  const systemctl = (...args: string[]) => run("systemctl", ["--user", ...args]);
  return {
    kind: "systemd",
    file,
    current: async (spec) => (await read(file)) === systemdUnit(spec),
    installed: () => exists(file),
    async install(spec) {
      const replacing = await exists(file);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, systemdUnit(spec), { mode: 0o644 });
      await check(systemctl("daemon-reload"), "systemctl --user daemon-reload");
      await check(systemctl("enable", "--now", SYSTEMD_UNIT), `systemctl --user enable --now ${SYSTEMD_UNIT}`);
      if (replacing) await check(systemctl("restart", SYSTEMD_UNIT), `systemctl --user restart ${SYSTEMD_UNIT}`);
    },
    async uninstall() {
      const had = await exists(file);
      if (had) await systemctl("disable", "--now", SYSTEMD_UNIT);
      await fs.rm(file, { force: true });
      if (had) await systemctl("daemon-reload");
      return had;
    },
  };
}

export interface ServiceOptions {
  platform?: NodeJS.Platform;
  home: string;
  uid?: number;
  env?: Record<string, string | undefined>;
  run?: Exec;
}

/** The login item for this platform; undefined where none is supported. */
export function serviceManager(options: ServiceOptions): ServiceManager | undefined {
  const platform = options.platform ?? process.platform;
  const run = options.run ?? exec;
  if (platform === "darwin") return launchd(options.home, options.uid ?? process.getuid?.() ?? 0, run);
  if (platform === "linux") return systemd(options.env?.XDG_CONFIG_HOME || path.join(options.home, ".config"), run);
  return undefined;
}
