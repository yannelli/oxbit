import type { Pack } from "@oxbit/icon-themes";
import { icons, productIconIds } from "@oxbit/ui";
import { rainbowAssociations } from "./associations.js";

type Theme = Pack["themes"][number]["data"];

const PACK_ID = "oxbit.rainbow-icons";
const assets: Pack["assets"] = Object.create(null);
// Recognizable flag bands, rather than a muted rainbow gradient.
const rainbow = [
  "#e40303",
  "#ff8c00",
  "#ffed00",
  "#008026",
  "#2448ff",
  "#750787",
];
const progress = ["#171717", "#784f32", "#55cdfc", "#f7a8b8", "#ffffff"];
function prideFlag() {
  const bands = rainbow
    .map((color, i) => rect(0, (i * 16) / 6, 16, 16 / 6 + 0.02, color))
    .join("");
  const chevrons = progress
    .map((color, i) => {
      const tip = 9 - i * 1.5;
      return '<path d="M-2 -2L' + tip + ' 8L-2 18Z" fill="' + color + '"/>';
    })
    .join("");
  return bands + chevrons;
}
const labels: Record<string, string> = {
  javascript: "JS",
  typescript: "TS",
  react: "RX",
  json: "{}",
  html: "<>",
  css: "#",
  markdown: "MD",
  python: "PY",
  rust: "RS",
  go: "GO",
  java: "JV",
  clike: "C",
  ruby: "RB",
  php: "PH",
  shell: ">_",
  sql: "DB",
  yaml: "YM",
  toml: "TM",
  xml: "<>",
  swift: "SW",
  csharp: "CS",
  vue: "VU",
  text: "TX",
  image: "IM",
  media: "AV",
  archive: "ZP",
  binary: "01",
  font: "Aa",
  database: "DB",
  lock: "LK",
  file: "",
  astro: "AS",
  dart: "DT",
  elixir: "EX",
  erlang: "ER",
  haskell: "HS",
  lua: "LU",
  perl: "PL",
  r: "R",
  scala: "SC",
  clojure: "CL",
  graphql: "GQ",
  kotlin: "KT",
  docker: "DK",
  terraform: "TF",
  protobuf: "PB",
  solidity: "SO",
  notebook: "NB",
  document: "PDF",
  spreadsheet: "CSV",
  test: "OK",
  audio: "AU",
  video: "VD",
  config: "CF",
  zig: "ZG",
  ocaml: "ML",
  node: "ND",
  git: "GT",
};
// Vector lettering stays crisp at explorer size and needs no external font.
const alphabet: Record<string, string> = {
  A: "010101111101101",
  B: "110101110101110",
  C: "011100100100011",
  D: "110101101101110",
  E: "111100110100111",
  F: "111100110100100",
  G: "011100101101011",
  H: "101101111101101",
  I: "111010010010111",
  J: "001001001101010",
  K: "101101110101101",
  L: "100100100100111",
  M: "101111111101101",
  N: "101111111111101",
  O: "010101101101010",
  P: "110101110100100",
  Q: "010101101111011",
  R: "110101110101101",
  S: "011100010001110",
  T: "111010010010010",
  U: "101101101101111",
  V: "101101101101010",
  W: "101101111111101",
  X: "101101010101101",
  Y: "101101010010010",
  Z: "111001010100111",
  0: "111101101101111",
  1: "010110010010111",
  "{": "011010100010011",
  "}": "110010001010110",
  "<": "001010100010001",
  ">": "100010001010100",
  _: "000000000000111",
  "#": "101111101111101",
};
function rect(
  x: number,
  y: number,
  width: number,
  height: number,
  color: string,
) {
  return (
    '<rect x="' +
    x +
    '" y="' +
    y +
    '" width="' +
    width +
    '" height="' +
    height +
    '" fill="' +
    color +
    '"/>'
  );
}
function lettering(label: string, color: string) {
  const scale = label.length > 2 ? 0.8 : 1;
  const left = 10 - ((label.length * 4 - 1) * scale) / 2;
  return [...label.toUpperCase()]
    .map((letter, i) =>
      [...(alphabet[letter] ?? alphabet.X)]
        .map((pixel, at) =>
          pixel === "1"
            ? rect(
                left + (i * 4 + (at % 3)) * scale,
                9 + Math.floor(at / 3) * scale,
                scale,
                scale,
                color,
              )
            : "",
        )
        .join(""),
    )
    .join("");
}
function asset(id: string, body: string) {
  const path = "icons/" + id + ".svg";
  assets[path] = {
    mime: "image/svg+xml",
    base64: btoa(
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">' +
        body +
        "</svg>",
    ),
  };
  return { iconPath: path };
}
const folderIds = new Set(Object.values(rainbowAssociations.folderNames));
const folderGlyphs: Record<string, string> = {
  source: icons.languageServer,
  tests: icons.check,
  assets: icons.eye,
  docs: icons.book,
  config: icons.gear,
  git: icons.git,
  dependencies: icons.package,
  build: icons.tasks,
  scripts: icons.terminal,
  components: icons.layoutSide,
  workspace: icons.ext,
};
const definitions: Theme["iconDefinitions"] = {};
for (const mode of ["dark", "light"] as const) {
  const sheet = mode === "dark" ? "#17141f" : "#ffffff";
  const foreground = mode === "dark" ? "#ffffff" : "#21182c";
  for (const [id, label] of Object.entries(labels)) {
    definitions[mode + "." + id] = asset(
      mode + "/" + id,
      '<defs><clipPath id="page"><path d="M2 1h9l4 4v10H2Z"/></clipPath></defs>' +
        '<g clip-path="url(#page)">' +
        prideFlag() +
        "</g>" +
        '<path d="M11 1v4h4M2 1h9l4 4v10H2Z" fill="none" stroke="' +
        foreground +
        '" stroke-width=".7"/>' +
        (label
          ? '<rect x="5.2" y="8" width="9.6" height="6.6" rx="1" fill="' +
            sheet +
            '"/>' +
            lettering(label, foreground)
          : ""),
    );
  }
  for (const id of ["folder", "workspace", ...folderIds]) {
    for (const open of [false, true]) {
      const shape = open
        ? "M1 6h14l-2 8H2z M2 6V2h4l2 2h5v2"
        : "M1 2h5l2 2h7v10H1z";
      const suffix = open ? "Open" : "";
      definitions[mode + ".folder." + id + suffix] = asset(
        mode + "/folder-" + id + suffix,
        '<defs><clipPath id="folder"><path d="' +
          shape +
          '"/></clipPath></defs>' +
          '<g clip-path="url(#folder)">' +
          prideFlag() +
          "</g>" +
          '<path d="' +
          shape +
          '" fill="none" stroke="' +
          foreground +
          '" stroke-width=".7" stroke-linejoin="round"/>' +
          '<rect x="8" y="6" width="7" height="8" rx="1.5" fill="' +
          sheet +
          '"/>' +
          '<g transform="translate(8.3 6.8) scale(.4)"><path d="' +
          (folderGlyphs[id] ?? icons.files) +
          '" fill="none" stroke="' +
          foreground +
          '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/></g>',
      );
    }
  }
}
function associations(mode: "dark" | "light") {
  const prefix = (entries: Record<string, string>, folder = false) =>
    Object.fromEntries(
      Object.entries(entries).map(([key, id]) => [
        key,
        mode + (folder ? ".folder." : ".") + id,
      ]),
    );
  return {
    file: mode + ".file",
    folder: mode + ".folder.folder",
    folderExpanded: mode + ".folder.folderOpen",
    rootFolder: mode + ".folder.workspace",
    rootFolderExpanded: mode + ".folder.workspaceOpen",
    fileExtensions: prefix(rainbowAssociations.fileExtensions),
    fileNames: prefix(rainbowAssociations.fileNames),
    languageIds: prefix(rainbowAssociations.languageIds),
    folderNames: prefix(rainbowAssociations.folderNames, true),
    folderNamesExpanded: prefix(
      Object.fromEntries(
        Object.entries(rainbowAssociations.folderNames).map(([key, id]) => [
          key,
          id + "Open",
        ]),
      ),
      true,
    ),
  };
}
const productDefinitions: Theme["iconDefinitions"] = {};
for (const [name, id] of Object.entries(productIconIds)) {
  if (!id || productDefinitions[id]) continue;
  const gradient =
    '<defs><linearGradient id="pride" x1="0" y1="0" x2="0" y2="1">' +
    rainbow
      .map(
        (color, i) =>
          '<stop offset="' +
          i / 6 +
          '" stop-color="' +
          color +
          '"/><stop offset="' +
          (i + 1) / 6 +
          '" stop-color="' +
          color +
          '"/>',
      )
      .join("") +
    "</linearGradient></defs>";
  productDefinitions[id] = asset(
    "controls/" + id,
    gradient +
      '<path d="' +
      icons[name] +
      '" fill="none" stroke="#261c35" stroke-width="2.7" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<path d="' +
      icons[name] +
      '" fill="none" stroke="url(#pride)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  );
}

export const rainbowIconPack: Pack = {
  formatVersion: 1,
  id: PACK_ID,
  revision: "4e2471c5-d25f-47e0-a708-ed3417c0d350",
  label: "Rainbow Pride Icons",
  publisher: "oxbit",
  version: "1.1.0",
  license: "MIT",
  enabled: true,
  description:
    "Bold rainbow stripes and Progress Pride chevrons for files, named folders and workbench controls. File icons follow light and dark themes automatically.",
  themes: [
    {
      id: PACK_ID + "/files",
      kind: "fileIconTheme",
      label: "Rainbow Pride",
      path: "files.json",
      data: {
        iconDefinitions: definitions,
        ...associations("dark"),
        light: associations("light"),
      },
    },
    {
      id: PACK_ID + "/controls",
      kind: "productIconTheme",
      label: "Rainbow Pride",
      path: "controls.json",
      data: { iconDefinitions: productDefinitions },
    },
  ],
  assets,
  warnings: [],
};
