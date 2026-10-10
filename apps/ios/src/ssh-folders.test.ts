import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => new Map<string, unknown>());
vi.mock("@oxbit/host-ios", () => ({
  SESSION_SCOPE: "session",
  native: {
    storageGet: async (scope: string, key: string) => storage.get(`${scope}:${key}`) ?? null,
    storageSet: async (scope: string, key: string, value: unknown) => { storage.set(`${scope}:${key}`, value); },
  },
}));
const { absoluteFolder, childFolder, loadHomeFolders, parentFolder, saveHomeFolder } = await import("./ssh-folders.js");

beforeEach(() => storage.clear());

describe("SSH folders", () => {
  it("reads the folder field like the native SFTP root", () => {
    expect(absoluteFolder("/home/dev", "~")).toBe("/home/dev");
    expect(absoluteFolder("/home/dev", " ")).toBe("/home/dev");
    expect(absoluteFolder("/home/dev", "project")).toBe("/home/dev/project");
    expect(absoluteFolder("/home/dev", "~/project/")).toBe("/home/dev/project");
    expect(absoluteFolder("/home/dev", "/srv//app/../web")).toBe("/srv/web");
  });

  it("moves up and into folders", () => {
    expect(parentFolder("/home/dev")).toBe("/home");
    expect(parentFolder("/home")).toBe("/");
    expect(parentFolder("/")).toBe("/");
    expect(childFolder("/", "srv")).toBe("/srv");
    expect(childFolder("/home", "dev")).toBe("/home/dev");
  });

  it("keeps one home folder per host", async () => {
    expect(await loadHomeFolders()).toEqual({});
    await saveHomeFolder("host-1", "/home/dev/work");
    await saveHomeFolder("host-2", "/srv");
    await saveHomeFolder("host-1", "/home/dev");
    expect(await loadHomeFolders()).toEqual({ "host-1": "/home/dev", "host-2": "/srv" });
    expect(storage.get("session:ssh-home-folders")).toEqual({ "host-1": "/home/dev", "host-2": "/srv" });
  });
});
