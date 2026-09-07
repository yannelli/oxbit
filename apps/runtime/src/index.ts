import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { run } from "./cli.js";
export { createRuntime } from "./runtime.js";
export { run, parse, resolveTarget } from "./cli.js";

// npm links the bin, so argv[1] is the link and import.meta.url is its target.
const here = fileURLToPath(import.meta.url);
const invoked = () => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === here;
  } catch {
    return false;
  }
};
if (invoked()) process.exit(await run(process.argv.slice(2), { entry: here }));
