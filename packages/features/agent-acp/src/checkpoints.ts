import type { ACPCheckpoint, ACPCheckpointDiff, ACPCheckpointRestore } from "@oxbit/sdk";
import type { Activity, Message } from "./history.js";

export const CHECKPOINT_TIMEOUT = 5000;
export const RESTORED_NOTICE = "Restored files to before “{message}”";
type Request = <T>(method: string, params?: Record<string, unknown>) => Promise<T>;

export const restoredNotice = (message: Message): Activity => {
  const text = message.text.replace(/\s+/g, " ").trim();
  return { kind: "notice", text: RESTORED_NOTICE, values: { message: text.length > 80 ? `${text.slice(0, 79)}…` : text } };
};

/** Client state for git checkpoints. The runtime hides the feature outside a repository root. */
export class Checkpoints {
  /** Workspace tree at the last snapshot. A message whose checkpoint differs can be restored. */
  current?: string;
  restoring = false;
  private refreshing = false;
  private stale = false;
  constructor(
    private request: Request,
    private changed: () => void,
    private messages: () => Message[],
  ) {}
  /** Snapshots the workspace. Failures and timeouts resolve to undefined so the prompt still sends. */
  async create(): Promise<string | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        this.request<ACPCheckpoint>("acp.checkpoint.create"),
        new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), CHECKPOINT_TIMEOUT))),
      ]);
      this.current = result && "tree" in result ? result.tree : undefined;
    } catch {
      this.current = undefined;
    } finally {
      clearTimeout(timer);
    }
    return this.current;
  }
  differs(message: Message) {
    return !!message.checkpoint && !!this.current && message.checkpoint !== this.current;
  }
  refresh() {
    if (!this.messages().some((message) => message.checkpoint)) return;
    if (this.refreshing) {
      this.stale = true;
      return;
    }
    this.refreshing = true;
    void this.create().finally(() => {
      this.refreshing = false;
      this.changed();
      if (this.stale) {
        this.stale = false;
        this.refresh();
      }
    });
  }
  /** Restores only the paths that differ, after checking them for unsaved editor edits. */
  async restore(tree: string, unsaved: (path: string) => boolean) {
    if (this.restoring) return undefined;
    this.restoring = true;
    try {
      const diff = await this.request<ACPCheckpointDiff>("acp.checkpoint.diff", { tree });
      if ("unavailable" in diff) throw new Error("This checkpoint is no longer available");
      this.current = diff.tree;
      const paths = diff.changes.map((change) => change.path);
      const dirty = paths.find(unsaved);
      if (dirty) throw new Error(`Save or revert your unsaved edits in ${dirty} before restoring this checkpoint.`);
      if (paths.length) await this.request<ACPCheckpointRestore>("acp.checkpoint.restore", { tree, paths });
      this.current = tree;
      return paths;
    } finally {
      this.restoring = false;
    }
  }
}

/** session/load replays messages without checkpoints. Match saved user messages in order by text. */
export function carryCheckpoints(saved: Activity[], activity: Activity[]) {
  const source = saved.flatMap((entry) =>
    entry.kind === "message" && entry.message.role === "user" && entry.message.checkpoint ? [entry.message] : [],
  );
  let next = 0;
  for (const entry of activity) {
    if (entry.kind !== "message" || entry.message.role !== "user") continue;
    const index = source.findIndex((message, i) => i >= next && message.text.trim() === entry.message.text.trim());
    if (index < 0) continue;
    entry.message.checkpoint ??= source[index]!.checkpoint;
    next = index + 1;
  }
}
