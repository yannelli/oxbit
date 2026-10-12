import { readFileSync } from "node:fs";

declare const __OXBIT_VERSION__: string | undefined;

// Bundles carry the version through a vite define; tsx reads the package manifest.
export function agentVersion(): string {
  if (typeof __OXBIT_VERSION__ === "string") return __OXBIT_VERSION__;
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  } catch {
    return "unknown";
  }
}
