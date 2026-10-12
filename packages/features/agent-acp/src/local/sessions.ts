import { CLEARED_OUTPUT, pruneToolOutputs, type SessionRecord, type SessionStore, type Turn } from "@oxbit/agent-core";
import type { Persistence } from "@oxbit/sdk";

type Summary = Omit<SessionRecord, "turns">;
/** Saved conversations per workspace; saving a newer one deletes the oldest. */
export const SESSION_LIMIT = 16;
/** JSON characters per saved conversation. iOS keeps a workspace's storage keys in one file of at most 64 MiB. */
export const RECORD_LIMIT = 2 * 1024 * 1024;
const VALID_ID = /^[\w.-]{1,128}$/;

const size = (turns: Turn[]) => JSON.stringify(turns).length;
/** Tool outputs before the last user turn read CLEARED_OUTPUT. */
function clearOldOutputs(turns: Turn[]): Turn[] {
  const last = turns.findLastIndex((turn) => turn.role === "user");
  return turns.map((turn, index) => turn.role === "tool" && index < last
    ? { role: "tool", results: turn.results.map((result) => ({ ...result, output: CLEARED_OUTPUT })) } : turn);
}
/** The turns, with old tool outputs cleared when the record is over RECORD_LIMIT. */
export function storedTurns(turns: Turn[]) {
  if (size(turns) <= RECORD_LIMIT) return turns;
  const pruned = pruneToolOutputs(turns).turns;
  if (size(pruned) <= RECORD_LIMIT) return pruned;
  const cleared = clearOldOutputs(pruned);
  if (size(cleared) <= RECORD_LIMIT) return cleared;
  throw new Error("This conversation is over 2 MiB, so it was not saved. Run /compact to save it again.");
}

const summaryOf = (value: any): Summary | undefined =>
  value && typeof value === "object" && typeof value.id === "string" && VALID_ID.test(value.id) && typeof value.cwd === "string"
    ? { id: value.id, cwd: value.cwd, title: String(value.title ?? ""), model: String(value.model ?? ""),
      meta: value.meta && typeof value.meta === "object" ? value.meta : {}, updatedAt: String(value.updatedAt ?? "") }
    : undefined;

/** Persistence over a Map, for hosts without storage. */
export function memoryPersistence(): Persistence {
  const values = new Map<string, unknown>();
  return {
    get: async <T>(key: string) => structuredClone(values.get(key)) as T | undefined,
    set: async (key, value) => void values.set(key, structuredClone(value)),
    delete: async (key) => void values.delete(key),
  };
}

/** Oxbit agent sessions in host storage: an index under `oxbit-agent-sessions:<scope>` and one key per session.
 * The scope is one workspace, so loaded and listed sessions read `root` as their cwd even when the folder's path changed. */
export class StoredSessions implements SessionStore {
  private index?: Promise<Summary[]>;
  private writes = Promise.resolve();
  constructor(private storage: Persistence, private scope: string, private root: string) {}
  private key(id: string) {
    return `oxbit-agent-session:${this.scope}:${id}`;
  }
  private summaries() {
    return this.index ??= this.storage.get<unknown[]>(`oxbit-agent-sessions:${this.scope}`).then(
      (list) => (Array.isArray(list) ? list : []).map(summaryOf).filter((item): item is Summary => !!item), () => []);
  }
  save(record: SessionRecord) {
    const run = this.writes.then(async () => {
      if (!VALID_ID.test(record.id)) throw new Error("Invalid session ID");
      const { turns, ...summary } = record;
      await this.storage.set(this.key(record.id), { ...record, turns: storedTurns(turns) });
      const list = [summary, ...(await this.summaries()).filter((item) => item.id !== record.id)]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      for (const dropped of list.splice(SESSION_LIMIT)) await this.storage.delete(this.key(dropped.id));
      this.index = Promise.resolve(list);
      await this.storage.set(`oxbit-agent-sessions:${this.scope}`, list);
    });
    this.writes = run.catch(() => {});
    return run;
  }
  async load(id: string): Promise<SessionRecord | undefined> {
    if (!VALID_ID.test(id)) return undefined;
    await this.writes;
    const value = await this.storage.get<SessionRecord>(this.key(id));
    const summary = summaryOf(value);
    return summary?.id === id && Array.isArray(value?.turns) ? { ...summary, cwd: this.root, turns: value.turns } : undefined;
  }
  /** The workspace's sessions, newest first, when `cwd` is its root. */
  async list(cwd: string) {
    await this.writes;
    return cwd === this.root ? (await this.summaries()).map((item) => ({ ...item, cwd })) : [];
  }
}
