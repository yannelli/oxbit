import { agentVersion } from "./version.js";

const args = process.argv.slice(2);
if (args.includes("--version") || args.includes("-v")) process.stdout.write(`oxbit-agent ${agentVersion()}\n`);
else {
  process.stderr.write("oxbit-agent: not implemented\n");
  process.exitCode = 1;
}
