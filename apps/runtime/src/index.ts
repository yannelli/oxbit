import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRuntime } from "./runtime.js";
export { createRuntime } from "./runtime.js";
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const runtime = await createRuntime({
    root: process.env.ZAPP_WORKSPACE ?? process.cwd(),
    port: Number(process.env.PORT ?? 4317),
    host: process.env.HOST ?? "127.0.0.1",
    dataDir: process.env.ZAPP_DATA_DIR,
    pairingCode: process.env.ZAPP_PAIRING_CODE,
    origins: process.env.ZAPP_ORIGINS?.split(",").filter(Boolean),
    webRoot: process.env.ZAPP_WEB_ROOT,
  });
  process.stdout.write(
    `Zapp runtime: http://${process.env.HOST ?? "127.0.0.1"}:${runtime.port}\nWorkspace: ${runtime.root}\nOwner pairing code: ${runtime.pairingCode}\n`,
  );
  const stop = () => {
    void runtime.close().then(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
