import { expect, it } from "vitest";
import path from "node:path";
import { setting, workspaceDataDir } from "../src/branding.js";
import { parse, USAGE } from "../src/cli.js";
import { dataDirFor } from "../src/daemon.js";

it("reads Oxbit runtime variables and exposes the Oxbit command", () => {
  for (const name of [
    "WORKSPACE",
    "DATA_DIR",
    "PAIRING_CODE",
    "ORIGINS",
    "WEB_ROOT",
    "WATCH_POLLING",
    "LSP_COMMAND",
  ]) {
    expect(setting(name, {})).toBeUndefined();
    expect(setting(name, { [`OXBIT_${name}`]: "configured" })).toBe("configured");
    expect(setting(name, { [`OXBIT_${name}`]: "" })).toBe("");
  }
  expect(parse([], { OXBIT_WORKSPACE: "/project" })).toMatchObject({
    target: "/project",
  });
  expect(dataDirFor("/workspace", { OXBIT_DATA_DIR: "/private" })).toBe("/private");
  expect(USAGE).toContain("oxbit [options] [path]");
  expect(USAGE).toContain("Open a workspace in Oxbit.");
});

it("isolates each workspace in a stable Oxbit data directory", () => {
  const home = path.resolve("test-home");
  const directory = workspaceDataDir("/project", home);
  expect(path.dirname(directory)).toBe(path.join(home, ".oxbit", "workspaces"));
  expect(path.basename(directory)).toMatch(/^[a-f0-9]{24}$/);
  expect(workspaceDataDir("/project", home)).toBe(directory);
  expect(workspaceDataDir("/other-project", home)).not.toBe(directory);
});
