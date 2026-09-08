import { unzipSync, zipSync, strToU8, strFromU8 } from "fflate";
import {
  parsePack,
  safeAssetPath,
  formatDiagnostics,
  type ThemePack,
} from "./index.js";
export const assetLimits = {
  archive: 50 * 1024 * 1024,
  expanded: 100 * 1024 * 1024,
  entries: 256,
  font: 20 * 1024 * 1024,
};
export function validateFont(path: string, bytes: Uint8Array) {
  if (!bytes.length || bytes.length > assetLimits.font)
    throw new Error(`${path} /: Font must be between 1 byte and 20 MB`);
  const signature = String.fromCharCode(...bytes.slice(0, 4));
  const extension = path.split(".").pop()?.toLowerCase();
  if (!(
    (extension === "woff2" && signature === "wOF2") ||
    (extension === "woff" && signature === "wOFF") ||
    (extension === "otf" && signature === "OTTO") ||
    (extension === "ttf" &&
      (signature === "\x00\x01\x00\x00" || signature === "true"))
  ))
    throw new Error(`${path} /: Invalid font signature`);
}
/** Read the central directory before decompression: no filesystem extraction is performed. */
export function inspectArchive(bytes: Uint8Array) {
  if (bytes.length > assetLimits.archive)
    throw new Error("Archive exceeds 50 MB");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--)
    if (
      view.getUint32(i, true) === 0x06054b50 &&
      i + 22 + view.getUint16(i + 20, true) === bytes.length
    ) {
      end = i;
      break;
    }
  if (end < 0) throw new Error("Invalid ZIP end directory");
  const count = view.getUint16(end + 10, true),
    size = view.getUint32(end + 12, true),
    offset = view.getUint32(end + 16, true);
  if (
    view.getUint16(end + 4, true) ||
    view.getUint16(end + 6, true) ||
    count !== view.getUint16(end + 8, true) ||
    count > assetLimits.entries ||
    offset + size !== end
  )
    throw new Error(
      "ZIP: split archives, ZIP64, or excessive entries are unsupported",
    );
  let pos = offset,
    total = 0;
  const paths = new Set<string>(),
    entries: { path: string; size: number; crc: number }[] = [];
  const ranges: [number, number][] = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let i = 0; i < count; i++) {
    if (pos + 46 > end || view.getUint32(pos, true) !== 0x02014b50)
      throw new Error("Invalid ZIP directory entry");
    const flags = view.getUint16(pos + 8, true),
      method = view.getUint16(pos + 10, true),
      compressed = view.getUint32(pos + 20, true),
      expanded = view.getUint32(pos + 24, true),
      length = view.getUint16(pos + 28, true),
      extra = view.getUint16(pos + 30, true),
      comment = view.getUint16(pos + 32, true),
      attributes = view.getUint32(pos + 38, true),
      local = view.getUint32(pos + 42, true);
    if (pos + 46 + length + extra + comment > end)
      throw new Error("Truncated ZIP entry");
    const path = decoder.decode(bytes.slice(pos + 46, pos + 46 + length));
    if (
      !safeAssetPath(path.endsWith("/") ? path.slice(0, -1) : path) ||
      (path.endsWith("/") && expanded !== 0) ||
      paths.has(path.toLowerCase()) ||
      ((attributes >>> 16) & 0xf000) === 0xa000 ||
      flags & 1 ||
      ![0, 8].includes(method)
    )
      throw new Error(
        `${path} /: Unsafe, duplicate, encrypted, or unsupported ZIP entry`,
      );
    paths.add(path.toLowerCase());
    total += expanded;
    if (expanded > assetLimits.font || total > assetLimits.expanded)
      throw new Error(`${path} /: Expanded asset limits exceeded`);
    if (local + 30 > offset || view.getUint32(local, true) !== 0x04034b50)
      throw new Error(`${path} /: Invalid local header`);
    const localName = view.getUint16(local + 26, true),
      localExtra = view.getUint16(local + 28, true);
    if (
      local + 30 + localName + localExtra + compressed > offset ||
      decoder.decode(bytes.slice(local + 30, local + 30 + localName)) !==
        path ||
      view.getUint16(local + 8, true) !== method ||
      view.getUint16(local + 6, true) !== flags
    )
      throw new Error(`${path} /: Local header mismatch`);
    const finish = local + 30 + localName + localExtra + compressed;
    if (ranges.some(([from, to]) => local < to && finish > from))
      throw new Error(`${path} /: Overlapping ZIP entries`);
    ranges.push([local, finish]);
    entries.push({ path, size: expanded, crc: view.getUint32(pos + 16, true) });
    pos += 46 + length + extra + comment;
  }
  if (
    pos !== end ||
    !paths.has("theme-pack.json") ||
    !entries.some((e) => e.path === "theme-pack.json")
  )
    throw new Error("ZIP requires root theme-pack.json");
  return entries;
}
export const isLicenseFile = (path: string) =>
  /(^|\/)(LICENSE|LICENCE|NOTICE|COPYING)(?:([._ -][a-zA-Z0-9_-]+)*\.(?:txt|md))?$/i.test(
    path,
  );
function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
export function readPackFile(bytes: Uint8Array, file: string) {
  if (bytes.length > assetLimits.archive)
    throw new Error(`${file} /: File exceeds 50 MB`);
  const entries = /\.zip$/i.test(file) ? inspectArchive(bytes) : undefined;
  const manifest = entries
    ? unzipSync(bytes, { filter: (entry) => entry.name === "theme-pack.json" })[
        "theme-pack.json"
      ]
    : bytes;
  const result = parsePack(strFromU8(manifest), file);
  if (!result.pack) throw new Error(formatDiagnostics(result.errors));
  const pack = result.pack,
    assets: Record<string, Uint8Array> = {};
  const declared = new Set((pack.fonts ?? []).map((font) => font.path));
  for (const entry of entries ?? [])
    if (
      entry.path !== "theme-pack.json" &&
      !entry.path.endsWith("/") &&
      !declared.has(entry.path) &&
      !isLicenseFile(entry.path)
    )
      throw new Error(
        `${entry.path} /: Only declared fonts and license files are allowed`,
      );
  const files: Record<string, Uint8Array> = entries ? unzipSync(bytes) : { "theme-pack.json": bytes };
  for (const entry of entries ?? []) {
    if (files[entry.path]?.length !== entry.size)
      throw new Error(`${entry.path} /: Expanded size mismatch`);
    if (crc32(files[entry.path]) !== entry.crc)
      throw new Error(`${entry.path} /: ZIP checksum mismatch`);
  }
  for (const [path, data] of Object.entries(files)) {
    if (path === "theme-pack.json" || path.endsWith("/")) continue;
    if (declared.has(path)) validateFont(path, data);
    assets[path] = data;
  }
  for (const font of pack.fonts ?? [])
    if (!assets[font.path])
      throw new Error(
        `${file} /fonts: Missing ${font.path}; import a ZIP containing declared font assets`,
      );
  return { pack, assets, warnings: result.warnings };
}
export function exportPack(
  pack: ThemePack,
  assets: Record<string, Uint8Array>,
) {
  return Object.keys(assets).length
    ? {
        extension: "zip",
        bytes: zipSync({
          "theme-pack.json": strToU8(JSON.stringify(pack, null, 2) + "\n"),
          ...assets,
        }),
      }
    : {
        extension: "json",
        bytes: strToU8(JSON.stringify(pack, null, 2) + "\n"),
      };
}
