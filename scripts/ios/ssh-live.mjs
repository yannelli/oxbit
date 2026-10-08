// Runs the iOS crate's live SSH test against the Docker sshd fixture from scripts/remote.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
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
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const freePort = () => new Promise((resolve, reject) => {
  const server = createServer().listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  }).on("error", reject);
});

const temp = mkdtempSync(join(tmpdir(), "oxbit-ios-ssh-"));
const name = `oxbit-ios-ssh-${randomBytes(4).toString("hex")}`;
const passphrase = randomBytes(12).toString("hex");
const password = randomBytes(12).toString("hex");
try {
  run("docker", ["build", "--platform", "linux/amd64", "-f", "scripts/remote/sshd.Dockerfile", "-t", "oxbit-ssh-test:local", "scripts/remote"], { cwd: root });
  run("ssh-keygen", ["-q", "-t", "ed25519", "-N", passphrase, "-C", "oxbit-live", "-f", join(temp, "identity")]);
  const [port, passwordPort] = [await freePort(), await freePort()];
  docker("run", "-d", "--name", name, "--platform", "linux/amd64",
    "-p", `127.0.0.1:${port}:22`, "-p", `127.0.0.1:${passwordPort}:2222`,
    "-v", `${join(temp, "identity.pub")}:/test-key:ro`, "oxbit-ssh-test:local");
  docker("exec", name, "sh", "-c",
    "cp /test-key /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys && " +
    `echo 'root:${password}' | chpasswd && /usr/sbin/sshd -p 2222 -o PasswordAuthentication=yes -o UsePAM=no -o PermitRootLogin=yes`);
  run("cargo", ["test", "--locked", "--lib", "ssh::live_", "--", "--ignored", "--nocapture", "--test-threads=1"], {
    cwd: crate,
    env: {
      ...process.env,
      OXBIT_SSH_TEST_CONTAINER: name,
      OXBIT_SSH_TEST_PORT: String(port),
      OXBIT_SSH_TEST_PASSWORD_PORT: String(passwordPort),
      OXBIT_SSH_TEST_KEY: join(temp, "identity"),
      OXBIT_SSH_TEST_PASSPHRASE: passphrase,
      OXBIT_SSH_TEST_PASSWORD: password,
    },
  });
} finally {
  try { docker("rm", "-f", name); } catch { /* the container never started */ }
  rmSync(temp, { recursive: true, force: true });
}
