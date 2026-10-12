import { open, readFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { SessionRecord, SessionStore, Turn } from "@oxbit/agent-core";
import { cwdHash, writeFileAtomic } from "./config.js";

type Summary = Omit<SessionRecord, "turns">;
const VALID_ID = /^[\w.-]{1,128}$/;
const HEADER_LIMIT = 16 * 1024 * 1024;

async function firstLine(file: string) {
  const handle = await open(file, "r");
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for (;;) {
      const buffer = Buffer.alloc(64 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, size);
      if (!bytesRead) break;
      const end = buffer.subarray(0, bytesRead).indexOf(10);
      chunks.push(buffer.subarray(0, end < 0 ? bytesRead : end));
      size += bytesRead;
      if (end >= 0 || size > HEADER_LIMIT) break;
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await handle.close();
  }
}

const summary = (header: any): Summary | undefined =>
  header?.type === "session" && typeof header.id === "string" && typeof header.cwd === "string"
    ? { id: header.id, cwd: header.cwd, title: String(header.title ?? ""), model: String(header.model ?? ""),
      meta: header.meta && typeof header.meta === "object" ? header.meta : {}, updatedAt: String(header.updatedAt ?? "") }
    : undefined;

/** JSONL under `<dir>/<cwd-hash>/<id>.jsonl`: a `session` header line, then one `turn` line per turn. Saves rewrite the file, since compaction and /undo replace turns. */
export class JsonlSessionStore implements SessionStore {
  private files = new Map<string, string>();
  constructor(private dir: string) {}
  private fileFor(record: { id: string; cwd: string }) {
    return join(this.dir, cwdHash(record.cwd), `${record.id}.jsonl`);
  }
  async save(record: SessionRecord) {
    if (!VALID_ID.test(record.id)) throw new Error("Invalid session ID");
    const file = this.fileFor(record);
    const { turns, ...header } = record;
    const lines = [JSON.stringify({ type: "session", version: 1, ...header }), ...turns.map((turn) => JSON.stringify({ type: "turn", turn }))];
    await writeFileAtomic(file, `${lines.join("\n")}\n`, 0o600);
    const previous = this.files.get(record.id);
    if (previous && previous !== file) await unlink(previous).catch(() => {});
    this.files.set(record.id, file);
  }
  private async find(id: string) {
    const known = this.files.get(id);
    if (known) return known;
    const dirs = await readdir(this.dir).catch(() => [] as string[]);
    for (const dir of dirs) {
      const file = join(this.dir, dir, `${id}.jsonl`);
      if (await open(file, "r").then((handle) => handle.close().then(() => true), () => false)) return file;
    }
    return undefined;
  }
  async load(id: string): Promise<SessionRecord | undefined> {
    if (!VALID_ID.test(id)) return undefined;
    const file = await this.find(id);
    if (!file) return undefined;
    const lines = (await readFile(file, "utf8")).split("\n").filter(Boolean);
    const head = summary(JSON.parse(lines[0] ?? "null"));
    if (!head || head.id !== id) throw new Error(`Session file ${file} has no valid header`);
    const turns: Turn[] = [];
    for (const line of lines.slice(1)) {
      const entry = JSON.parse(line);
      if (entry?.type === "turn" && entry.turn) turns.push(entry.turn);
    }
    this.files.set(id, file);
    return { ...head, turns };
  }
  /** Sessions for `cwd`, newest first. */
  async list(cwd: string): Promise<Summary[]> {
    const dir = join(this.dir, cwdHash(cwd));
    const names = await readdir(dir).catch(() => [] as string[]);
    const records: Summary[] = [];
    for (const name of names.filter((item) => item.endsWith(".jsonl"))) {
      try {
        const head = summary(JSON.parse(await firstLine(join(dir, name))));
        if (head && head.cwd === cwd) records.push(head);
      } catch {
        // A partly written or foreign file is skipped.
      }
    }
    return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async latest(cwd: string) {
    return (await this.list(cwd))[0];
  }
}
