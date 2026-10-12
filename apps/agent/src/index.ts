import { main } from "./cli.js";

// No top-level await: the TUI chunk imports shared code from this entry, which must finish evaluating first.
void main(process.argv.slice(2), { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, env: process.env, cwd: process.cwd() })
  .then((code) => process.stdout.write("", () => process.exit(code)));
