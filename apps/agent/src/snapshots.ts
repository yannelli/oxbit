import { spawn } from "node:child_process";
import { access, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentCommand, CommandContext, CommandProvider, SnapshotStore, Turn } from "@oxbit/agent-core";
import { cwdHash } from "./config.js";

const TREE = /^[0-9a-f]{40,64}$/;
interface GitResult { code: number; stdout: string; stderr: string }

/** Snapshots of `cwd` as git trees in a separate GIT_DIR. The work tree's .gitignore files apply. Without git, capture returns undefined. */
export class GitSnapshotStore implements SnapshotStore {
  private ready?: Promise<boolean>;
  constructor(readonly cwd: string, readonly gitDir: string, private log: (text: string) => void = () => {}) {}
  private git(args: string[]): Promise<GitResult> {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_DIR: this.gitDir, GIT_WORK_TREE: this.cwd, GIT_TERMINAL_PROMPT: "0" };
    for (const name of ["GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR"]) delete env[name];
    return new Promise((resolve, reject) => {
      const child = spawn("git", ["-c", "core.autocrlf=false", "-c", "core.safecrlf=false", "-c", "core.quotepath=false", "-c", "gc.auto=0", ...args],
        { cwd: this.cwd, env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (data: string) => void (stdout += data));
      child.stderr.setEncoding("utf8").on("data", (data: string) => void (stderr += data));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });
  }
  private async checked(args: string[]) {
    const result = await this.git(args);
    if (result.code !== 0) throw new Error(`git ${args[0]}: ${result.stderr.trim() || `exit ${result.code}`}`);
    return result.stdout;
  }
  /** False for the home directory and /, where a snapshot would copy too much. */
  private init() {
    return this.ready ??= (async () => {
      if (this.cwd === "/" || this.cwd === homedir()) return false;
      try {
        await access(join(this.gitDir, "HEAD"));
      } catch {
        await mkdir(this.gitDir, { recursive: true, mode: 0o700 });
        await this.checked(["init", "--quiet"]);
      }
      return true;
    })().catch((error) => {
      this.log(`Snapshots are off: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    });
  }
  /** Unreadable files fail `git add` with a nonzero exit after the others are staged, so its code is not checked. */
  private async stage() {
    await this.git(["add", "--all", "--ignore-errors", "--", "."]);
  }
  async capture(_label: string) {
    if (!await this.init()) return undefined;
    try {
      await this.stage();
      return (await this.checked(["write-tree"])).trim();
    } catch (error) {
      this.log(`Snapshot failed: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }
  /** Puts the work tree back to the snapshot: changed and deleted files return, files created since are removed. */
  async restore(id: string) {
    if (!TREE.test(id)) throw new Error("Invalid snapshot ID");
    if (!await this.init()) throw new Error("Snapshots are unavailable");
    await this.stage();
    const added = (await this.checked(["diff-index", "--cached", "--name-only", "-z", "--diff-filter=A", id])).split("\0").filter(Boolean);
    for (const path of added) await rm(join(this.cwd, path), { force: true });
    await this.checked(["read-tree", id]);
    await this.checked(["checkout-index", "--all", "--force"]);
  }
}

/** One GitSnapshotStore per cwd under `<dir>/<cwd-hash>`. */
export function snapshotStores(dir: string, log?: (text: string) => void) {
  const stores = new Map<string, GitSnapshotStore>();
  return (cwd: string) => {
    let store = stores.get(cwd);
    if (!store) stores.set(cwd, store = new GitSnapshotStore(cwd, join(dir, cwdHash(cwd)), log));
    return store;
  };
}

interface Snapshot { id: string; label: string; turn: number }
interface RedoEntry { id: string; turns: Turn[]; snapshots: Snapshot[]; at: number }
const list = <T>(value: unknown) => (Array.isArray(value) ? value : []) as T[];
const notice = (context: CommandContext, text: string) =>
  context.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });

/** /undo restores files to before the last prompt that changed them and drops that prompt; /redo reverses it. */
export function undoCommands(storeFor: (cwd: string) => SnapshotStore): CommandProvider {
  const undo: AgentCommand = {
    name: "undo",
    description: "Restore files to before the last prompt that changed them and remove that prompt",
    async run(_args, context) {
      const { session } = context;
      const snapshots = list<Snapshot>(session.meta.snapshots);
      const last = snapshots.at(-1);
      if (!last) {
        notice(context, "Nothing to undo.");
        return { done: "end_turn" };
      }
      const turns = [...session.turns];
      const user = Math.max(0, turns.slice(0, last.turn).map((turn) => turn.role).lastIndexOf("user"));
      const group = snapshots.filter((snapshot) => snapshot.turn > user);
      const store = storeFor(session.cwd);
      const current = await store.capture("Before /undo");
      if (!current) throw new Error("Snapshots are unavailable, so /undo cannot restore files");
      await store.restore(group[0].id);
      context.replaceTurns(turns.slice(0, user));
      session.meta.snapshots = snapshots.slice(0, snapshots.length - group.length);
      const entry: RedoEntry = { id: current, turns: turns.slice(user), snapshots: group, at: user };
      session.meta.redo = [...list<RedoEntry>(session.meta.redo), entry];
      notice(context, `Restored files to before "${group[0].label}" and removed the last prompt. Run /redo to bring it back.`);
      return { done: "end_turn" };
    },
  };
  const redo: AgentCommand = {
    name: "redo",
    description: "Reapply the changes and prompt that /undo removed",
    async run(_args, context) {
      const { session } = context;
      const entries = list<RedoEntry>(session.meta.redo);
      const entry = entries.at(-1);
      if (!entry || entry.at !== session.turns.length) {
        session.meta.redo = [];
        notice(context, entry ? "Nothing to redo: the conversation changed after /undo." : "Nothing to redo.");
        return { done: "end_turn" };
      }
      await storeFor(session.cwd).restore(entry.id);
      context.replaceTurns([...session.turns, ...entry.turns]);
      session.meta.snapshots = [...list<Snapshot>(session.meta.snapshots), ...entry.snapshots];
      session.meta.redo = entries.slice(0, -1);
      notice(context, "Reapplied the changes from the undone prompt.");
      return { done: "end_turn" };
    },
  };
  return { commands: () => [undo, redo] };
}
