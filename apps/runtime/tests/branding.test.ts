import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setting, workspaceDataDir } from "../src/branding.js";
import { parse, USAGE } from "../src/cli.js";
import { dataDirFor } from "../src/daemon.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

it("uses Oxbit variables first while accepting existing launch scripts", () => {
  for (const name of [
    "WORKSPACE",
    "DATA_DIR",
    "PAIRING_CODE",
    "ORIGINS",
    "WEB_ROOT",
    "WATCH_POLLING",
    "LSP_COMMAND",
  ]) {
    expect(setting(name, { [`ZAPP_${name}`]: "old" })).toBe("old");
    expect(
      setting(name, { [`ZAPP_${name}`]: "old", [`OXBIT_${name}`]: "new" }),
    ).toBe("new");
  }
  expect(parse([], { ZAPP_WORKSPACE: "/old" })).toMatchObject({
    target: "/old",
  });
  expect(
    parse([], { ZAPP_WORKSPACE: "/old", OXBIT_WORKSPACE: "/new" }),
  ).toMatchObject({ target: "/new" });
  expect(dataDirFor("/workspace", { ZAPP_DATA_DIR: "/old" })).toBe("/old");
  expect(
    dataDirFor("/workspace", { ZAPP_DATA_DIR: "/old", OXBIT_DATA_DIR: "/new" }),
  ).toBe("/new");
  expect(USAGE).toContain("oxbit [options] [path]");
  expect(USAGE).toContain("Open a workspace in Oxbit.");
});

it("reuses existing private data in place and creates new workspaces under .oxbit", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "oxbit-branding-"));
  directories.push(home);
  const current = workspaceDataDir("/project", home);
  expect(current).toContain(path.join(home, ".oxbit", "workspaces"));
  const legacy = current.replace(
    `${path.sep}.oxbit${path.sep}`,
    `${path.sep}.zapp${path.sep}`,
  );
  await mkdir(legacy, { recursive: true });
  expect(workspaceDataDir("/project", home)).toBe(legacy);
  expect(workspaceDataDir("/other-project", home)).toContain(
    path.join(home, ".oxbit", "workspaces"),
  );
  await mkdir(current, { recursive: true });
  expect(workspaceDataDir("/project", home)).toBe(current);
});
