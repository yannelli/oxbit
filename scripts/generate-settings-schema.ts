import * as fs from "node:fs/promises";
import { createSettingsSchema } from "./settings-schema.js";

const text = JSON.stringify(createSettingsSchema(), null, 2) + "\n";
for (const file of ["packages/sdk/src/settings.schema.json", "apps/web/public/schemas/settings.v1.schema.json"]) {
  if (process.argv.includes("--check")) {
    if (await fs.readFile(file, "utf8") !== text) throw new Error(`Regenerate ${file} with pnpm settings:schema`);
  } else await fs.writeFile(file, text);
}
