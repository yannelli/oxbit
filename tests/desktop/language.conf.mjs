import { config as base } from "./wdio.conf.mjs";
import path from "node:path";
import * as fs from "node:fs/promises";
const directory = path.join(process.env.OXBIT_NATIVE_FIXTURES, "Alpha project");
await fs.writeFile(path.join(directory, "language.ini"), "[section]\nname=value\n");
await fs.writeFile(path.join(directory, "language.csv"), "name,age\nAda,42\n");
await fs.writeFile(path.join(directory, "hello.ts"), 'export function greet(name: string) { return name.toUpperCase(); }\nconst greeting = greet("world");\ngreeting.toUpperCase();\n');
const binary = path.resolve("apps/desktop/src-tauri/target/debug/oxbit-language-test");
export const config = { ...base, specs: ["./language.e2e.mjs"], capabilities: [{ browserName: "tauri", "tauri:options": { application: binary } }],
  services: [["@wdio/tauri-service", { appBinaryPath: binary, driverProvider: "embedded", embeddedPort: 4463, captureBackendLogs: true, captureFrontendLogs: true, logDir: path.resolve("evidence/language-milestone1/native"), startTimeout: 60000 }]],
  outputDir: path.resolve("evidence/language-milestone1/native"), mochaOpts: { timeout: 180000 },
};
