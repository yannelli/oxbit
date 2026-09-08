import { config as base } from "./wdio.conf.mjs";
import path from "node:path";
process.env.OXBIT_TASKS_HOME = path.join(
  process.env.OXBIT_NATIVE_FIXTURES,
  "Task home",
);
export const config = { ...base, specs: ["./tasks.e2e.mjs"] };
