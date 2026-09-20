/** Build transportable headless payloads. Only the build host needs downloads / Docker. */
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
const source = path.resolve(
  process.argv[process.argv.indexOf("--from-stage") + 1] || ".",
);
if (!process.argv.includes("--from-stage") || !source)
  throw new Error("Run bun run remote:prepare");
const pins = JSON.parse(
  await fs.readFile(path.join(root, "scripts/desktop/binaries.json"), "utf8"),
);
const output = path.join(source, "remote");
const cache = path.join(root, ".desktop-cache");
await fs.mkdir(output, { recursive: true });
const dockerHelpers = "/Applications/Docker.app/Contents/Resources/bin";
const dockerEnvironment =
  process.platform === "darwin" &&
  (await fs.stat(dockerHelpers).catch(() => undefined))
    ? { ...process.env, PATH: `${dockerHelpers}:${process.env.PATH}` }
    : process.env;
const run = (cmd, args, options = {}) =>
  execFileSync(cmd, args, {
    stdio: "inherit",
    ...(cmd === "docker" ? { env: dockerEnvironment } : {}),
    ...options,
  });
async function unpack(binary) {
  const archive = path.join(cache, path.basename(binary.url));
  try {
    await fs.access(archive);
  } catch {
    run("curl", [
      "--fail",
      "--location",
      "--retry",
      "3",
      "--output",
      archive + ".partial",
      binary.url,
    ]);
    await fs.rename(archive + ".partial", archive);
  }
  const digest = createHash("sha256")
    .update(await fs.readFile(archive))
    .digest("hex");
  if (digest !== binary.sha256)
    throw new Error(`Checksum mismatch: ${archive}`);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oxbit-remote-tool-"));
  run("tar", ["-xzf", archive, "--strip-components=1", "-C", dir]);
  return dir;
}
const manifest = { version: 1, platforms: {} };
const targets = process.env.OXBIT_REMOTE_TARGETS?.split(",") ?? [
  "darwin-arm64",
  "linux-x64",
];
for (const platform of targets) {
  if (!["darwin-arm64", "linux-x64"].includes(platform))
    throw new Error(`Unsupported remote target: ${platform}`);
  if (process.env.OXBIT_REMOTE_PAYLOADS) {
    const supplied = path.join(
      process.env.OXBIT_REMOTE_PAYLOADS,
      `remote-runtime-${platform}`,
    );
    const expected = JSON.parse(
      await fs.readFile(path.join(supplied, "manifest.json"), "utf8"),
    ).platforms[platform];
    const archive = await fs.readFile(
      path.join(supplied, `${platform}.tar.gz`),
    );
    if (createHash("sha256").update(archive).digest("hex") !== expected.sha256)
      throw new Error(`Remote artifact checksum mismatch: ${platform}`);
    await fs.writeFile(path.join(output, `${platform}.tar.gz`), archive);
    manifest.platforms[platform] = expected;
    continue;
  }
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "oxbit-remote-build-"));
  try {
    const stage = path.join(temp, "runtime");
    await fs.cp(source, stage, {
      recursive: true,
      filter: (entry) => entry !== output,
    });
    const pin = pins[platform];
    for (const [name, sourcePath] of [
      ["node", "bin/node"],
      ["rg", "rg"],
    ]) {
      const tool = await unpack(pin[name]);
      try {
        await fs.copyFile(
          path.join(tool, sourcePath),
          path.join(stage, "bin", name),
        );
      } finally {
        await fs.rm(tool, { recursive: true, force: true });
      }
    }
    // The npm package includes macOS prebuilds; Linux is built for Node 24 in a
    // Linux build environment. Nothing is compiled or downloaded on the SSH host.
    const pty = path.join(stage, "node_modules/node-pty");
    const original = path.join(
      root,
      "apps/runtime/node_modules/node-pty/prebuilds",
      platform,
    );
    await fs.rm(path.join(pty, "build"), { recursive: true, force: true });
    await fs.rm(path.join(pty, "prebuilds"), { recursive: true, force: true });
    if (platform === "darwin-arm64") {
      await fs.cp(original, path.join(pty, "prebuilds", platform), {
        recursive: true,
      });
      await fs.chmod(
        path.join(pty, "prebuilds", platform, "spawn-helper"),
        0o755,
      );
    } else if (process.platform === "linux" && process.arch === "x64") {
      await fs.cp(
        path.join(root, "apps/runtime/node_modules/node-pty/build"),
        path.join(pty, "build"),
        { recursive: true },
      );
    } else {
      run("docker", [
        "run",
        "--rm",
        "--platform",
        "linux/amd64",
        "-v",
        `${stage}:/runtime`,
        "-w",
        "/runtime/node_modules/node-pty",
        `node:${pins.nodeVersion}-bookworm@sha256:be23f54a88d34e8824c741b19b91064094f92c1c97b194144bfc8b50d67258e2`,
        "node",
        "/usr/local/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js",
        "rebuild",
        "--nodedir=/usr/local",
      ]);
    }
    if (platform === "linux-x64") {
      const addon = await fs.readFile(path.join(pty, "build/Release/pty.node"));
      await fs.rm(path.join(pty, "build"), { recursive: true, force: true });
      await fs.mkdir(path.join(pty, "build/Release"), { recursive: true });
      await fs.writeFile(path.join(pty, "build/Release/pty.node"), addon);
    }
    await fs.copyFile(
      path.join(root, "LICENSE"),
      path.join(stage, "licenses/OXBIT-LICENSE"),
    );
    const inventory = JSON.parse(
      await fs.readFile(path.join(stage, "inventory.json"), "utf8"),
    );
    await fs.writeFile(
      path.join(stage, "inventory.json"),
      JSON.stringify(
        {
          ...inventory,
          platform,
          node: pins.nodeVersion,
          ripgrep: pins.ripgrepVersion,
          downloads: pin,
        },
        null,
        2,
      ) + "\n",
    );
    const archive = path.join(output, `${platform}.tar.gz`);
    run("tar", ["-czf", archive, "-C", stage, "."], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    manifest.platforms[platform] = {
      sha256: createHash("sha256")
        .update(await fs.readFile(archive))
        .digest("hex"),
    };
    console.log(`Remote payload: ${platform}`);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}
await fs.writeFile(
  path.join(output, "manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);
