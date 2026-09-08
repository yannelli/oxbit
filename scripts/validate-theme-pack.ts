import { readFile } from "node:fs/promises";
import { readPackFile, resolveTheme } from "../packages/themes/src/index.js";
const files = process.argv.slice(2);
if (!files.length) {
  console.error(
    "Usage: pnpm themes:validate path/to/theme-pack.json [pack.zip …]",
  );
  process.exitCode = 1;
}
for (const file of files)
  try {
    const result = readPackFile(new Uint8Array(await readFile(file)), file);
    for (const theme of result.pack.themes) resolveTheme(result.pack, theme.id);
    console.log(`${file}: valid (${result.pack.themes.length} themes)`);
    for (const warning of result.warnings)
      console.warn(`${file} ${warning.path}: ${warning.message}`);
  } catch (error) {
    console.error(String(error));
    process.exitCode = 1;
  }
