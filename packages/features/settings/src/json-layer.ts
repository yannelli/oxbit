import type { Kernel } from "@oxbit/sdk";

type Layer = Record<string, unknown>;
type Layers = { user: Layer; workspace: Layer; userLanguages: Record<string, Layer>; workspaceLanguages: Record<string, Layer> };

export function readLayer(kernel: Kernel, scope: "user" | "workspace", language?: string): Layer {
  const data = kernel.configuration.export() as Layers;
  if (!language) return data[scope] ?? {};
  return (scope === "user" ? data.userLanguages : data.workspaceLanguages)[language] ?? {};
}

/** Writes only the keys that differ from `original`; restores the prior configuration if any write throws. */
export function applyLayer(kernel: Kernel, original: Layer, next: Layer, scope: "user" | "workspace", language?: string) {
  const snapshot = kernel.configuration.export();
  try {
    for (const key of Object.keys(original))
      if (!Object.hasOwn(next, key)) kernel.configuration.reset(key, scope, language);
    for (const [key, value] of Object.entries(next))
      if (!Object.hasOwn(original, key) || JSON.stringify(original[key]) !== JSON.stringify(value))
        kernel.configuration.set(key, value, scope, language);
  } catch (error) {
    kernel.configuration.import(snapshot);
    throw error;
  }
}
