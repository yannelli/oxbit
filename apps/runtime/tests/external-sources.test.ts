import { afterEach, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { dependencyRoots } from "../src/managed/dependencies.js";
import { ExternalSources } from "../src/external-sources.js";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
it("authorizes only registered canonical roots and invalidates handles on restart", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "oxbit-external-")); roots.push(root);
  const dependency = path.join(root, "dependency"); await fs.mkdir(dependency);
  await fs.writeFile(path.join(dependency, "lib.d.ts"), "declare const value: string;");
  await fs.writeFile(path.join(root, "private.txt"), "outside");
  const sources = new ExternalSources(); await sources.register([dependency]);
  const grant = await sources.authorize(pathToFileURL(path.join(dependency, "lib.d.ts")).href);
  expect(await sources.read(grant.handle)).toMatchObject({ readonly: true, text: "declare const value: string;" });
  await expect(sources.authorize(pathToFileURL(path.join(root, "private.txt")).href)).rejects.toMatchObject({ code: "PATH_DENIED" });
  await fs.symlink(path.join(root, "private.txt"), path.join(dependency, "escape.txt"));
  await expect(sources.authorize(pathToFileURL(path.join(dependency, "escape.txt")).href)).rejects.toMatchObject({ code: "PATH_DENIED" });
  await fs.unlink(path.join(dependency, "lib.d.ts")); await fs.symlink(path.join(root, "private.txt"), path.join(dependency, "lib.d.ts"));
  await expect(sources.read(grant.handle)).rejects.toMatchObject({ code: "PATH_DENIED" });
  sources.clear(); await expect(sources.read(grant.handle)).rejects.toMatchObject({ code: "PATH_DENIED" });
});

it("registers transitive installed package-store roots without trusting unrelated paths", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "oxbit-package-roots-")); roots.push(root);
  const project = path.join(root, "project"), first = path.join(root, "store/first"), second = path.join(root, "store/second");
  for (const directory of [project, first, second]) await fs.mkdir(path.join(directory, "node_modules"), { recursive: true });
  await fs.writeFile(path.join(project, "package.json"), JSON.stringify({ dependencies: { first: "1" } }));
  await fs.writeFile(path.join(first, "package.json"), JSON.stringify({ name: "first", dependencies: { second: "1" } }));
  await fs.writeFile(path.join(second, "package.json"), JSON.stringify({ name: "second", dependencies: { first: "1" } }));
  await fs.symlink(first, path.join(project, "node_modules/first"));
  await fs.symlink(second, path.join(first, "node_modules/second"));
  await fs.symlink(first, path.join(second, "node_modules/first"));
  expect(await dependencyRoots(project)).toEqual([await fs.realpath(first), await fs.realpath(second)]);
  const controller = new AbortController(); controller.abort(); await expect(dependencyRoots(project, controller.signal)).rejects.toThrow();
});
