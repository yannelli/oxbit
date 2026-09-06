import { readdir, readFile, writeFile } from "node:fs/promises";
import ts from "typescript";
const findings = [],
  modules = new Set();
for (const file of await readdir("apps/web/dist/assets")) {
  if (file.endsWith(".js.map")) {
    const map = JSON.parse(
      await readFile("apps/web/dist/assets/" + file, "utf8"),
    );
    for (const source of map.sources) {
      modules.add(source);
      if (
        /\/apps\/runtime\/|\/node-pty\/|\/ws\/lib\/|\/chokidar\//.test(source)
      )
        findings.push({ file, module: source });
    }
  }
  if (!file.endsWith(".js")) continue;
  const text = await readFile("apps/web/dist/assets/" + file, "utf8");
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  for (const statement of source.statements) {
    if (
      (ts.isImportDeclaration(statement) ||
        ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      /^(node:|__vite-browser-external)/.test(statement.moduleSpecifier.text)
    )
      findings.push({ file, module: statement.moduleSpecifier.text });
  }
}
await writeFile(
  "evidence/browser-bundle.json",
  JSON.stringify(
    {
      check:
        "Browser module graph and top-level imports exclude runtime Node dependencies",
      modules: modules.size,
      findings,
    },
    null,
    2,
  ),
);
if (findings.length) throw new Error(JSON.stringify(findings));
