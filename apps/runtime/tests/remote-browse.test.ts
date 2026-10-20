import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PathPolicy, listDirectory } from "../src/remote/browse.js";

let base = "";
let home = "";
let policy: PathPolicy;

beforeAll(async () => {
  // The lexical temp path on macOS goes through the /var symlink, so home is reached through a symlink too.
  base = await fs.mkdtemp(path.join(os.tmpdir(), "oxr-browse-"));
  home = path.join(base, "home");
  const dirs = ["Projects/b", "Projects/a", "Projects/10", "Projects/9", ".ssh", ".config/gcloud", ".config/nvim", "Library/Keychains", "Library/Fonts", "dotfiles/aws", "outside"];
  for (const dir of dirs) await fs.mkdir(path.join(dir.startsWith("outside") ? base : home, dir), { recursive: true });
  await fs.writeFile(path.join(home, "Projects", "notes.txt"), "");
  await fs.writeFile(path.join(home, ".ssh", "id_ed25519"), "secret");
  await fs.writeFile(path.join(home, ".profile"), "");
  await fs.symlink(path.join(base, "outside"), path.join(home, "escape"));
  await fs.symlink(path.join(home, ".ssh"), path.join(home, "keys"));
  await fs.symlink(path.join(home, "Projects"), path.join(home, "work"));
  await fs.symlink(path.join(home, "Projects", "notes.txt"), path.join(home, "notes-link"));
  await fs.symlink(path.join(home, "missing"), path.join(home, "dangling"));
  await fs.symlink(path.join(home, "dotfiles", "aws"), path.join(home, ".aws"));
  policy = await PathPolicy.create(home);
});
afterAll(() => fs.rm(base, { recursive: true, force: true }));

const code = (promise: Promise<unknown>) => promise.then(() => "ok", (error: { code?: string }) => error.code);

describe("host.list", () => {
  it("lists the home folder with directories first and hidden entries left out", async () => {
    const listing = await listDirectory(policy, undefined);
    expect(listing.path).toBe(await fs.realpath(home));
    expect(listing.parent).toBeUndefined();
    expect(listing.entries).toEqual([
      { name: "dotfiles", kind: "directory" },
      { name: "Library", kind: "directory" },
      { name: "Projects", kind: "directory" },
      { name: "work", kind: "directory" },
      { name: "notes-link", kind: "file" },
    ]);
  });

  it("sorts names numerically and reports the parent", async () => {
    const listing = await listDirectory(policy, "~/Projects");
    expect(listing.parent).toBe(await fs.realpath(home));
    expect(listing.entries.map((entry) => entry.name)).toEqual(["9", "10", "a", "b", "notes.txt"]);
    expect(await listDirectory(policy, "Projects")).toEqual(listing);
    expect(await listDirectory(policy, path.join(home, "Projects"))).toEqual(listing);
  });

  it("caps the listing size", async () => {
    const listing = await listDirectory(policy, "~/Projects", 2);
    expect(listing).toMatchObject({ entries: [{ name: "9" }, { name: "10" }], truncated: true });
  });

  it("leaves out hidden paths inside listed folders, including symlinked targets", async () => {
    expect((await listDirectory(policy, "~/Library")).entries).toEqual([{ name: "Fonts", kind: "directory" }]);
    expect((await listDirectory(policy, "~/dotfiles")).entries).toEqual([]);
    expect((await listDirectory(policy, "~/.config")).entries).toEqual([{ name: "nvim", kind: "directory" }]);
  });

  it("refuses hidden paths, traversal, and symlink escapes", async () => {
    expect(await code(listDirectory(policy, "~/.ssh"))).toBe("FORBIDDEN");
    expect(await code(listDirectory(policy, "~/Projects/../.ssh"))).toBe("FORBIDDEN");
    expect(await code(listDirectory(policy, "~/keys"))).toBe("FORBIDDEN");
    expect(await code(listDirectory(policy, "~/.config/gcloud"))).toBe("FORBIDDEN");
    expect(await code(listDirectory(policy, "~/Library/Keychains"))).toBe("FORBIDDEN");
    expect(await code(listDirectory(policy, "~/dotfiles/aws"))).toBe("FORBIDDEN");
    expect(await code(listDirectory(policy, "~/.oxbit"))).toBe("FORBIDDEN");
    expect(await code(listDirectory(policy, "~/escape"))).toBe("FORBIDDEN");
    expect(await code(listDirectory(policy, "~/.."))).toBe("FORBIDDEN");
    expect(await code(listDirectory(policy, "/etc"))).toBe("FORBIDDEN");
    expect(await code(listDirectory(policy, "~/missing"))).toBe("NOT_FOUND");
    expect(await code(listDirectory(policy, "~/dangling"))).toBe("NOT_FOUND");
    expect(await code(listDirectory(policy, "~/Projects/notes.txt"))).toBe("NOT_A_DIRECTORY");
    expect(await code(listDirectory(policy, 42))).toBe("INVALID_PARAMS");
    expect(await code(listDirectory(policy, "~/.config/nvim"))).toBe("ok");
    if (process.platform === "darwin") expect(await code(listDirectory(policy, "~/.SSH"))).toBe("FORBIDDEN");
  });

  it("checks host.open targets with the same policy", async () => {
    expect(await policy.directory("~/work")).toBe(await fs.realpath(path.join(home, "Projects")));
    expect(await code(policy.directory("~/keys"))).toBe("FORBIDDEN");
    expect(await policy.directory("~/escape/..")).toBe(await fs.realpath(home));
  });
});
