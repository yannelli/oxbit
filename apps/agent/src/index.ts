import { main } from "./cli.js";

const code = await main(process.argv.slice(2), { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, env: process.env, cwd: process.cwd() });
await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
process.exit(code);
