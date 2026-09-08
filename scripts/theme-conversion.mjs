import { readFileSync } from "node:fs";
const catalog = JSON.parse(
  readFileSync(
    new URL("../packages/themes/src/catalog.json", import.meta.url),
    "utf8",
  ),
);
export const hexColor = (value) =>
  value.replace(
    /rgba?\(([^)]+)\)/g,
    (_match, parts) =>
      "#" +
      parts
        .split(",")
        .map((part, i) =>
          Math.round(Number(part) * (i === 3 ? 255 : 1))
            .toString(16)
            .padStart(2, "0"),
        )
        .join(""),
  );
export function convertPalette(theme) {
  const colors = {},
    syntax = {};
  for (const [key, entry] of Object.entries(catalog.colors))
    if (theme.data.variables[entry.css])
      colors[key] = hexColor(theme.data.variables[entry.css]);
  for (const [key, entry] of Object.entries(catalog.syntax))
    if (theme.data.variables[entry.css])
      syntax[key] = { foreground: hexColor(theme.data.variables[entry.css]) };
  const shadow =
    theme.data.variables["--shadow"] === "none"
      ? []
      : hexColor(theme.data.variables["--shadow"])
          .split(",")
          .map((value) => {
            const match = value
              .trim()
              .match(
                /^(-?[\d.]+)(?:px)? (-?[\d.]+)(?:px)? ([\d.]+)px (#[\da-fA-F]+)$/,
              );
            if (!match) throw new Error("Unsupported shadow " + value);
            return {
              x: Number(match[1]),
              y: Number(match[2]),
              blur: Number(match[3]),
              spread: 0,
              color: match[4],
            };
          });
  return {
    id: theme.id.replace("oxbit.", ""),
    name: theme.title,
    mode: theme.data.mode,
    base: `builtin:${theme.data.mode}`,
    pairedTheme: theme.data.pairedTheme.replace("oxbit.", ""),
    colors,
    syntax,
    effects: { shadow },
  };
}
