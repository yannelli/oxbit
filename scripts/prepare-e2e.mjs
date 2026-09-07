import { mkdir, writeFile, readFile, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
const root = await mkdtemp(path.join(os.tmpdir(), "oxbit-e2e-"));
const seed = JSON.parse(await readFile("apps/web/src/seed.json", "utf8"));
for (const entry of Array.isArray(seed) ? seed : seed.files) {
  if (!entry.path || entry.text === undefined) continue;
  const file = path.join(root, entry.path);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, entry.text);
}
await writeFile(
  path.join(root, "acceptance.ts"),
  'export const greeting: string = "hello";\nexport function welcome(name: string) { return greeting + name; }\nconst result = welcome("world");\n',
);
await writeFile(
  path.join(root, "rename.ts"),
  'import { shared } from "./collab";\nexport const beforeName = 7;\nconsole.log(beforeName);\n',
);
await writeFile(
  path.join(root, "diagnostics.ts"),
  'const count: number = "bad";\nconsole.log(count);\n',
);
await writeFile(path.join(root, "search-a.txt"), "alpha beta alpha\n");
await writeFile(path.join(root, "search-b.txt"), "alpha gamma\n");
await writeFile(
  path.join(root, "collab.ts"),
  'export const shared = "ready";\n',
);
await writeFile(
  path.join(root, "tsconfig.json"),
  JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      strict: true,
      noUnusedLocals: true,
    },
    include: ["acceptance.ts", "rename.ts", "diagnostics.ts", "collab.ts"],
  }),
);
execFileSync("git", ["init", "-b", "main"], { cwd: root });
execFileSync("git", ["config", "user.name", "Oxbit Acceptance"], { cwd: root });
execFileSync("git", ["config", "user.email", "acceptance@oxbit.test"], {
  cwd: root,
});
execFileSync("git", ["add", "."], { cwd: root });
execFileSync("git", ["commit", "-m", "Initial acceptance fixture"], {
  cwd: root,
});
await mkdir("evidence", { recursive: true });
await writeFile(
  "evidence/e2e-workspace.json",
  JSON.stringify({ root, dataDir: root + "-runtime" }),
);
