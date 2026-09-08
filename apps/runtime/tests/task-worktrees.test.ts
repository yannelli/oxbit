import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { TaskConfigStore } from "../src/tasks/config.js";
import { TaskRunner } from "../src/tasks/runner.js";
import { TaskWorktrees } from "../src/tasks/worktrees.js";
import { runCommand } from "../src/processes.js";
import type { TaskHooks } from "@oxbit/sdk";
const fixtures: { dir: string; runner: TaskRunner }[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.runner.close();
    await fs.rm(f.dir, { recursive: true, force: true });
  }
});
async function fixture(worktree: TaskHooks) {
  const dir = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), "oxbit-worktree-hooks-"),
    ),
    root = path.join(dir, "project");
  await fs.mkdir(root);
  const git = async (args: string[], cwd = root) => {
    const result = await runCommand("git", args, {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Oxbit test",
        GIT_AUTHOR_EMAIL: "oxbit@example.invalid",
        GIT_COMMITTER_NAME: "Oxbit test",
        GIT_COMMITTER_EMAIL: "oxbit@example.invalid",
      },
    });
    if (result.exitCode) throw new Error(result.stderr);
    return result.stdout;
  };
  await git(["init"]);
  await fs.writeFile(path.join(root, "README.md"), "fixture\n");
  await fs.writeFile(path.join(root, ".gitignore"), "generated\n");
  await git(["add", "."]);
  await git(["commit", "-m", "Initial fixture"]);
  const store = await TaskConfigStore.create(root, { home: dir }),
    runner = new TaskRunner(store, () => {}),
    worktrees = new TaskWorktrees(store, runner);
  fixtures.push({ dir, runner });
  const source = (await store.catalog()).sources.find((s) => s.private)!;
  await store.saveSettings({
    sourceId: source.id,
    worktree,
    env: {},
    expectedRevision: null,
  });
  return { dir, root, git, store, runner, worktrees };
}
describe("managed worktree lifecycle", () => {
  it("runs all four phases in order with source, target and staging variables", async () => {
    const { root, store, worktrees, runner, dir } = await fixture({
      preinit:
        'test ! -e "$OXBIT_PROJECT_DIR"\nprintf "preinit\\n" > "$OXBIT_PREINIT_DIR/order"\nprintf "seed" > seed',
      init: 'test -f "$OXBIT_SOURCE_DIR/README.md"\ncp "$OXBIT_PREINIT_DIR/seed" generated\nprintf "init\\n" >> "$OXBIT_PREINIT_DIR/order"',
      preteardown:
        'test -f "$OXBIT_PROJECT_DIR/generated"\nprintf "preteardown\\n" >> "$OXBIT_PREINIT_DIR/order"',
      teardown:
        'test ! -e "$OXBIT_PROJECT_DIR"\nprintf "teardown\\n" >> "$OXBIT_PREINIT_DIR/order"\ncp "$OXBIT_PREINIT_DIR/order" "$OXBIT_SOURCE_DIR/lifecycle-result"',
    });
    const tree = await worktrees.create("owner", "feature/test");
    expect(tree.state).toBe("ready");
    expect(await fs.readFile(path.join(tree.path, "generated"), "utf8")).toBe(
      "seed",
    );
    expect(
      (await TaskConfigStore.create(tree.path, { home: dir })).projectId,
    ).toBe(store.projectId);
    await worktrees.remove("owner", tree.id);
    expect(await worktrees.list()).toEqual([]);
    expect(await fs.readFile(path.join(root, "lifecycle-result"), "utf8")).toBe(
      "preinit\ninit\npreteardown\nteardown\n",
    );
    expect(runner.list("owner").map((run) => run.state)).toEqual([
      "completed",
      "completed",
      "completed",
      "completed",
    ]);
    await expect(fs.stat(tree.preinitDir)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("preserves failed initialization for inspection and permits a deliberate retry", async () => {
    const { root, worktrees } = await fixture({
      init: 'test -f "$OXBIT_SOURCE_DIR/allow-init"',
    });
    await expect(
      worktrees.create("owner", "feature/retry"),
    ).rejects.toMatchObject({ code: "WORKTREE_FAILED" });
    const [tree] = await worktrees.list();
    expect(tree.state).toBe("init-failed");
    expect((await fs.stat(tree.path)).isDirectory()).toBe(true);
    await fs.writeFile(path.join(root, "allow-init"), "");
    await worktrees.retryInit("owner", tree.id);
    expect((await worktrees.list())[0].state).toBe("ready");
    await worktrees.remove("owner", tree.id);
  });
  it("refuses dirty worktree removal and keeps the directory when preteardown fails", async () => {
    const { worktrees, root } = await fixture({
      preteardown: 'test -f "$OXBIT_SOURCE_DIR/allow-remove"',
    });
    const tree = await worktrees.create("owner", "feature/dirty");
    await fs.writeFile(path.join(tree.path, "unsaved.txt"), "important");
    await expect(worktrees.remove("owner", tree.id)).rejects.toMatchObject({
      code: "WORKTREE_DIRTY",
    });
    expect(await fs.readFile(path.join(tree.path, "unsaved.txt"), "utf8")).toBe(
      "important",
    );
    await fs.unlink(path.join(tree.path, "unsaved.txt"));
    await expect(worktrees.remove("owner", tree.id)).rejects.toMatchObject({
      code: "HOOK_FAILED",
    });
    expect((await fs.stat(tree.path)).isDirectory()).toBe(true);
    await fs.writeFile(path.join(root, "allow-remove"), "");
    await worktrees.remove("owner", tree.id);
  });
  it("retains staging after failed post-removal teardown and retries without rerunning preteardown", async () => {
    const { worktrees, root, runner } = await fixture({
      preteardown: "echo before",
      teardown: 'test -f "$OXBIT_SOURCE_DIR/allow-teardown"',
    });
    const tree = await worktrees.create("owner", "feature/teardown");
    await expect(worktrees.remove("owner", tree.id)).rejects.toMatchObject({
      code: "HOOK_FAILED",
    });
    expect((await worktrees.list())[0].state).toBe("teardown-failed");
    await expect(fs.stat(tree.path)).rejects.toMatchObject({ code: "ENOENT" });
    await fs.writeFile(path.join(root, "allow-teardown"), "");
    await worktrees.remove("owner", tree.id);
    expect(
      runner.list("owner").filter((run) => run.name.endsWith("preteardown")),
    ).toHaveLength(1);
  });
  it("recovers interrupted worktree initialization without rerunning hooks automatically", async () => {
    const { store, worktrees } = await fixture({ init: "echo initialized" });
    const tree = await worktrees.create("owner", "feature/interrupted");
    const file = path.join(store.projectHome, "worktrees.json");
    const records = JSON.parse(await fs.readFile(file, "utf8"));
    records[0].state = "creating";
    records[0].operationPid = 2147483647;
    await fs.writeFile(file, JSON.stringify(records));
    expect((await worktrees.list())[0].state).toBe("init-failed");
    await worktrees.retryInit("owner", tree.id);
    expect((await worktrees.list())[0].state).toBe("ready");
    await worktrees.remove("owner", tree.id);
  });
});
