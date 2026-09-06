import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import ts from "typescript";
const source = await readFile("packages/sdk/src/index.ts", "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.ESNext,
  },
}).outputText;
await mkdir("apps/web/public/sdk", { recursive: true });
await writeFile("apps/web/public/sdk/index.js", output);
await copyFile("LICENSE", "apps/web/public/LICENSE.txt");
