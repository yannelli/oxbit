import { readFileSync } from "node:fs";

declare const __OXBIT_VERSION__: string | undefined;

let cached: string | undefined;
// Bundles carry the version through a vite define; tsx reads the package manifest.
export function runtimeVersion() {
  if (cached) return cached;
  if (typeof __OXBIT_VERSION__ === "string") return (cached = __OXBIT_VERSION__);
  try {
    cached = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  } catch {
    cached = undefined;
  }
  return cached ?? "unknown";
}
