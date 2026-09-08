import type { Pack } from "@oxbit/icon-themes";
import { bitmap, invert, svgAsset } from "./bitmap.js";
import { fileAssociations } from "./associations.js";
import { fileDefinitions } from "./files.js";
import { arrowGlyphs } from "./controls-arrows.js";
import { viewGlyphs } from "./controls-views.js";
import { shellGlyphs } from "./controls-shell.js";
import { statusGlyphs } from "./controls-status.js";
import { toolGlyphs } from "./controls-tools.js";

export const CLASSICOS98_PACK_ID = "oxbit.classicos98";
/** Fixed, so re-seeding an installed pack is a no-op the desktop store accepts. */
export const CLASSICOS98_REVISION = "07e7069a-9987-4c4c-aa2f-28a335743f73";

const assets: Pack["assets"] = Object.create(null);

function definitions(svgs: Record<string, string>, directory: string) {
  const entries: Record<string, { iconPath: string }> = {};
  for (const [id, svg] of Object.entries(svgs)) {
    const path = `${directory}/${id}.svg`;
    assets[path] = svgAsset(svg);
    entries[id] = { iconPath: path };
  }
  return entries;
}

const controlGlyphs = {
  ...arrowGlyphs,
  ...viewGlyphs,
  ...shellGlyphs,
  ...statusGlyphs,
  ...toolGlyphs,
};

const render = (transform: (rows: string[]) => string[]) =>
  Object.fromEntries(
    Object.entries(controlGlyphs).map(([id, rows]) => [
      id,
      bitmap(transform(rows)),
    ]),
  );

const files = definitions(fileDefinitions, "icons/files");
const controls = definitions(render((rows) => rows), "icons/controls");
const controlsDark = definitions(render(invert), "icons/controls-dark");

export const classicOS98IconPack: Pack = {
  formatVersion: 1,
  id: CLASSICOS98_PACK_ID,
  revision: CLASSICOS98_REVISION,
  label: "ClassicOS 98 Icons",
  publisher: "oxbit",
  version: "1.0.0",
  license: "MIT",
  description:
    "16x16 VGA pixel art for files, folders and workbench controls, matching the ClassicOS 98 colour themes.",
  enabled: true,
  themes: [
    {
      id: `${CLASSICOS98_PACK_ID}/files`,
      kind: "fileIconTheme",
      label: "ClassicOS 98",
      path: "icons/files.json",
      data: { iconDefinitions: files, ...fileAssociations },
    },
    {
      id: `${CLASSICOS98_PACK_ID}/controls`,
      kind: "productIconTheme",
      label: "ClassicOS 98",
      path: "icons/controls.json",
      data: { iconDefinitions: controls },
    },
    {
      id: `${CLASSICOS98_PACK_ID}/controls-dark`,
      kind: "productIconTheme",
      label: "ClassicOS 98 Dark",
      path: "icons/controls-dark.json",
      data: { iconDefinitions: controlsDark },
    },
  ],
  assets,
  warnings: [],
};
