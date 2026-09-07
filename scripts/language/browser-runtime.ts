import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRuntime } from "../../apps/runtime/src/runtime.js";
const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "oxbit-language-browser-"));
await fs.writeFile(path.join(root, "package.json"), '{"name":"language-fixture","private":true}');
await fs.writeFile(path.join(root, ".marksman.toml"), "");
const runtime = await createRuntime({ root, port: 9534, dataDir: root + "-data", pairingCode: "oxbit-acceptance-2026", webRoot: path.resolve("apps/web/dist") });
async function close() { await runtime.close(); await fs.rm(root, { recursive: true, force: true }); await fs.rm(root + "-data", { recursive: true, force: true }); process.exit(0); }
process.on("SIGTERM", () => void close());
process.on("SIGINT", () => void close());
