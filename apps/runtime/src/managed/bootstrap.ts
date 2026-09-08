import * as fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
// Some upstream servers call console.info while resolving optional integrations.
// Keep those messages on stderr so they cannot corrupt the JSON-RPC stdout stream.
const source = '"use strict";\nconst { Console } = require("node:console");\nglobal.console = new Console({ stdout: process.stderr, stderr: process.stderr });\n';
export async function consoleBootstrap(cache: string) {
  const directory = path.join(cache, "bootstrap"); await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, `stdio-${createHash("sha256").update(source).digest("hex")}.cjs`);
  try { if (await fs.readFile(target, "utf8") === source) return target; } catch { /* Create a verified bootstrap below. */ }
  const stage = target + "." + randomUUID();
  try { await fs.writeFile(stage, source, { mode: 0o600 }); await fs.rename(stage, target); }
  finally { await fs.rm(stage, { force: true }); }
  return target;
}
