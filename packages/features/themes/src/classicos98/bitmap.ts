/** 16x16 pixel art in the VGA palette, drawn as horizontal runs of `rect`. */
const palette: Record<string, string> = {
  k: "#000000",
  d: "#808080",
  g: "#c0c0c0",
  s: "#dfdfdf",
  w: "#ffffff",
  R: "#800000",
  r: "#ff0000",
  Y: "#808000",
  y: "#ffff00",
  G: "#008000",
  l: "#00ff00",
  C: "#008080",
  c: "#00ffff",
  B: "#000080",
  b: "#0000ff",
  M: "#800080",
  m: "#ff00ff",
  t: "#ffffe1",
};

export function bitmap(rows: string[]): string {
  if (rows.length !== 16 || rows.some((row) => row.length !== 16))
    throw new Error("Icon bitmaps are 16 rows of 16 pixels");
  const rects: string[] = [];
  rows.forEach((row, y) => {
    for (let x = 0; x < 16; ) {
      const pixel = row[x];
      let width = 1;
      while (row[x + width] === pixel) width++;
      if (pixel !== ".") {
        const fill = palette[pixel];
        if (!fill) throw new Error(`Unknown palette entry: ${pixel}`);
        rects.push(
          `<rect x="${x}" y="${y}" width="${width}" height="1" fill="${fill}"/>`,
        );
      }
      x += width;
    }
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" shape-rendering="crispEdges">${rects.join("")}</svg>`;
}

/** Swaps the neutral ramp so black-outlined art reads on a dark 3D face. */
const inverted: Record<string, string> = {
  k: "w",
  w: "k",
  g: "d",
  d: "g",
  s: "k",
};

export const invert = (rows: string[]) =>
  rows.map((row) =>
    [...row].map((pixel) => inverted[pixel] ?? pixel).join(""),
  );

/** ASCII-only SVG text, so `btoa` is the byte-accurate base64 the store expects. */
export function svgAsset(svg: string): { mime: string; base64: string } {
  if (/[^\x20-\x7e]/.test(svg)) throw new Error("Icon SVG must be ASCII");
  return { mime: "image/svg+xml", base64: btoa(svg) };
}

const blank = `..k${"w".repeat(11)}k.`;

/** A white sheet with a folded corner. `marks` paints seven 9-pixel rows. */
export function page(marks: string[]): string[] {
  if (marks.length !== 7 || marks.some((row) => row.length !== 9))
    throw new Error("Page marks are 7 rows of 9 pixels");
  return [
    "..kkkkkkkkk.....",
    "..kwwwwwwwkk....",
    "..kwwwwwwwkgk...",
    "..kwwwwwwwkggk..",
    "..kwwwwwwwkkkkk.",
    blank,
    ...marks.map((row) => `..kw${row}wk.`),
    blank,
    blank,
    `..${"k".repeat(13)}.`,
  ];
}
