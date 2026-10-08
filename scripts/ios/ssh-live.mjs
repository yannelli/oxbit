// Runs the iOS crate's live SSH test against the Docker sshd fixture from scripts/remote.
import { execFileSync, spawn } from "node:child_process";
import { createReadStream, mkdtempSync, rmSync, existsSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const root = fileURLToPath(new URL("../../", import.meta.url));
const crate = join(root, "apps/ios/src-tauri");
const helpers = "/Applications/Docker.app/Contents/Resources/bin";
if (existsSync(helpers)) process.env.PATH = `${helpers}:${process.env.PATH}`;
const run = (command, args, options = {}) => execFileSync(command, args, { stdio: "inherit", ...options });
// Async so the tarball server below keeps answering while cargo runs.
const runAsync = (command, args, options) => new Promise((resolve, reject) => {
  spawn(command, args, { stdio: "inherit", ...options }).on("error", reject)
    .on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
});
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const freePort = () => new Promise((resolve, reject) => {
  const server = createServer().listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  }).on("error", reject);
});

// The remote runtime test needs `bun run remote:prepare`; the host downloads from this server.
const payload = join(root, "apps/desktop/src-tauri/resources/runtime/remote");
const hasPayload = existsSync(join(payload, "linux-x64.tar.gz"));
const files = createHttpServer((request, response) => {
  if (request.url !== "/linux-x64.tar.gz") return response.writeHead(404).end();
  response.writeHead(200, { "content-type": "application/gzip" });
  createReadStream(join(payload, "linux-x64.tar.gz")).pipe(response);
});
await new Promise((resolve) => files.listen(0, "127.0.0.1", resolve));
if (!hasPayload) console.log("live_remote_runtime skipped: run `bun run remote:prepare` first");

const temp = mkdtempSync(join(tmpdir(), "oxbit-ios-ssh-"));
const name = `oxbit-ios-ssh-${randomBytes(4).toString("hex")}`;
const passphrase = randomBytes(12).toString("hex");
const password = randomBytes(12).toString("hex");
try {
  run("docker", ["build", "--platform", "linux/amd64", "-f", "scripts/remote/sshd.Dockerfile", "-t", "oxbit-ssh-test:local", "scripts/remote"], { cwd: root });
  run("ssh-keygen", ["-q", "-t", "ed25519", "-N", passphrase, "-C", "oxbit-live", "-f", join(temp, "identity")]);
  const [port, passwordPort] = [await freePort(), await freePort()];
  docker("run", "-d", "--name", name, "--platform", "linux/amd64",
    ...(process.platform === "linux" ? ["--add-host", "host.docker.internal:host-gateway"] : []), "-p", `127.0.0.1:${port}:22`, "-p", `127.0.0.1:${passwordPort}:2222`,
    "-v", `${join(temp, "identity.pub")}:/test-key:ro`, "oxbit-ssh-test:local");
  docker("exec", name, "sh", "-c",
    "cp /test-key /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys && " +
    `echo 'root:${password}' | chpasswd && /usr/sbin/sshd -p 2222 -o PasswordAuthentication=yes -o UsePAM=no -o PermitRootLogin=yes`);
  await runAsync("cargo", ["test", "--locked", "--lib", process.argv[2] ?? "ssh::live_", "--", "--ignored", "--nocapture", "--test-threads=1",
    ...(hasPayload ? [] : ["--skip", "live_remote_runtime"])], {
    cwd: crate,
    env: {
      ...process.env,
      OXBIT_SSH_TEST_CONTAINER: name,
      OXBIT_SSH_TEST_PORT: String(port),
      OXBIT_SSH_TEST_PASSWORD_PORT: String(passwordPort),
      OXBIT_SSH_TEST_KEY: join(temp, "identity"),
      OXBIT_SSH_TEST_PASSPHRASE: passphrase,
      OXBIT_SSH_TEST_PASSWORD: password,
      OXBIT_SSH_TEST_PAYLOAD_DIR: payload,
      OXBIT_SSH_TEST_PAYLOAD_URL: `http://host.docker.internal:${files.address().port}`,
    },
  });
} finally {
  files.close();
  try { docker("rm", "-f", name); } catch { /* the container never started */ }
  rmSync(temp, { recursive: true, force: true });
}
