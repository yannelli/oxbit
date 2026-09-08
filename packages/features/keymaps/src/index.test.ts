import { describe, expect, it } from "vitest";
import type { Kernel } from "@oxbit/sdk";
import { normalizeShortcut } from "@oxbit/workbench";
import catalog from "../../../workbench/src/catalog.json";
import { createFeature, KEYMAP_SETTING, keymaps } from "./index.js";

const defaults = new Map([
  ...catalog.commands.map((command) => [command.id, command.win ?? ""] as const),
  // Registered with a `shortcut` that the catalog does not carry.
  ["editor.format", "Ctrl+Shift+I"],
  ["search.findInFiles", "Ctrl+Shift+F"],
]);
const scope = (id: string) => id.split(".")[0]!;
const effective = (bindings: Record<string, string>) =>
  new Map([...defaults, ...Object.entries(bindings)]);

const collisions = (bindings: Map<string, string>) => {
  const byKey = new Map<string, string[]>();
  for (const [id, key] of bindings) {
    if (!key) continue;
    const normalized = normalizeShortcut(key);
    byKey.set(normalized, [...(byKey.get(normalized) ?? []), id]);
  }
  return new Set(
    [...byKey]
      // Commands in different focus scopes may share a key; focus picks the winner.
      .filter(([, ids]) => new Set(ids.map(scope)).size !== ids.length)
      .map(([key, ids]) => `${key} -> ${ids.join(", ")}`),
  );
};

const cases = keymaps.map((keymap) => [keymap.stableId, keymap] as const);

describe("bundled keymaps", () => {
  it.each(cases)("%s only rebinds commands Oxbit registers", (_id, keymap) => {
    expect(
      Object.keys(keymap.bindings).filter((id) => !defaults.has(id)),
    ).toEqual([]);
  });

  it.each(cases)("%s adds no shortcut collision", (_id, keymap) => {
    const existing = collisions(defaults);
    expect(
      [...collisions(effective(keymap.bindings))].filter(
        (entry) => !existing.has(entry),
      ),
    ).toEqual([]);
  });

  it.each(cases)("%s hides no binding behind a chord", (_id, keymap) => {
    const bindings = [...effective(keymap.bindings)].filter(([, key]) => key);
    const chords = bindings.map(([, key]) => normalizeShortcut(key));
    expect(
      bindings
        // Terminal focus outranks a chord prefix, so a bare terminal key still fires.
        .filter(([id]) => !id.startsWith("terminal."))
        .map(([id, key]) => [id, normalizeShortcut(key)] as const)
        .filter(
          ([, key]) =>
            !key.includes(" ") &&
            chords.some((other) => other.startsWith(`${key} `)),
        )
        .map(([id, key]) => `${id} -> ${key}`),
    ).toEqual([]);
  });

  it.each(cases)("%s avoids keys Shift rewrites", (_id, keymap) => {
    expect(
      Object.entries(keymap.bindings)
        .filter(([, key]) =>
          normalizeShortcut(key)
            .split(" ")
            .some((chord) => {
              const parts = chord.split("+");
              const final = parts.pop()!;
              return parts.includes("shift") && !/^([a-z]|f\d+|\w{2,})$/.test(final);
            }),
        )
        .map(([id, key]) => `${id} -> ${key}`),
    ).toEqual([]);
  });

  it("offers every keymap as a setting value and a contribution", () => {
    const { manifest } = createFeature({ kernel: {} as Kernel });
    const setting = manifest.configuration?.[0];
    expect(setting?.id).toBe(KEYMAP_SETTING);
    expect(setting?.default).toBe("default");
    expect(setting?.enum).toEqual([
      "default",
      ...keymaps.map((keymap) => keymap.stableId),
    ]);
    expect(manifest.contributions?.map((item) => item.kind)).toEqual(
      keymaps.map(() => "keymap"),
    );
  });
});
