import type { InstalledPack, ResolvedTheme } from "@oxbit/themes";
const loaded = new Map<
  string,
  { faces: FontFace[]; users: number; promise: Promise<void> }
>();
export const internalFamily = (packId: string, fontId: string) =>
  "oxbit-" +
  [...(packId + "\0" + fontId)]
    .map((c) => c.charCodeAt(0).toString(16).padStart(4, "0"))
    .join("");
export function scopeFonts(theme: ResolvedTheme, entry: InstalledPack) {
  const result = structuredClone(theme);
  for (const font of Object.values(result.typography))
    font.family = font.family.map((f) =>
      entry.pack.fonts?.some((x) => x.id === f)
        ? internalFamily(entry.pack.id, f)
        : f,
    );
  return result;
}
export function acquireFonts(
  entry: InstalledPack,
  warn: (message: string) => void,
) {
  let hash = 2166136261;
  for (const font of entry.pack.fonts ?? [])
    for (const byte of entry.assets[font.path] ?? [])
      hash = Math.imul(hash ^ byte, 16777619);
  const key = JSON.stringify([
    entry.pack.id,
    entry.pack.version,
    entry.pack.fonts,
    hash,
  ]);
  let record = loaded.get(key);
  if (!record) {
    record = { faces: [], users: 0, promise: Promise.resolve() };
    const current = record;
    record.promise = Promise.all(
      (entry.pack.fonts ?? []).map(async (font) => {
        try {
          const bytes = entry.assets[font.path];
          const face = new FontFace(
            internalFamily(entry.pack.id, font.id),
            new Uint8Array(bytes).buffer,
            {
              weight: String(font.weight ?? 400),
              style: font.style ?? "normal",
            },
          );
          await face.load();
          if (current.users > 0) {
            document.fonts.add(face);
            current.faces.push(face);
          }
        } catch (error) {
          warn(
            `${font.path}: Font could not load; using fallback families. ${String(error)}`,
          );
        }
      }),
    ).then(() => {});
    loaded.set(key, record);
  }
  record.users++;
  const current = record;
  return {
    ready: record.promise,
    dispose() {
      if (--current.users === 0) {
        for (const face of current.faces) document.fonts.delete(face);
        loaded.delete(key);
      }
    },
  };
}
