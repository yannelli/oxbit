import type { ACPContext, ACPProviderId, Persistence } from "@oxbit/sdk";

export type Message = {
  id?: string;
  role: "user" | "agent" | "thought";
  text: string;
  context?: ACPContext[];
};
export type Activity =
  | { kind: "message"; message: Message }
  | { kind: "tool"; id: string }
  | { kind: "notice"; text: string };
export type Conversation = {
  id: string;
  sessionId: string;
  root: string;
  provider: ACPProviderId;
  title: string;
  updatedAt: string;
  draft: string;
  context: ACPContext[];
  activity: Activity[];
  tools: [string, Record<string, any>][];
  truncated?: boolean;
};
const MAX_BYTES = 4 * 1024 * 1024;
/** Workspace-local history. Store only display data, never approvals or process handles. */
export class ConversationHistory {
  entries: Conversation[] = [];
  private writes = Promise.resolve();
  readonly ready: Promise<void>;
  error = "";
  constructor(
    private storage: Persistence | undefined,
    private key: string,
  ) {
    this.ready = this.restore();
  }
  private async restore() {
    try {
      const saved = await this.storage?.get<{
        version: number;
        entries: Conversation[];
      }>(this.key);
      if (saved?.version === 1 && Array.isArray(saved.entries))
        this.entries = saved.entries
          .filter(
            (entry) =>
              typeof entry.id === "string" &&
              typeof entry.sessionId === "string" &&
              typeof entry.root === "string" &&
              typeof entry.title === "string" &&
              ["codex", "cursor", "amp"].includes(entry.provider) &&
              Array.isArray(entry.activity) &&
              Array.isArray(entry.tools) &&
              Array.isArray(entry.context),
          )
          .slice(0, 30);
    } catch {
      this.error = "Conversation history could not be loaded";
    }
  }
  save(entry: Conversation) {
    // Clone before enqueueing: streamed content must not mutate a pending write.
    const copy = JSON.parse(JSON.stringify(entry)) as Conversation;
    while (copy.activity.length > 100) {
      copy.activity.shift();
      copy.truncated = true;
    }
    copy.tools = copy.tools.filter(([id]) =>
      copy.activity.some((a) => a.kind === "tool" && a.id === id),
    );
    // Tool payloads and long transcripts are previews; draft context stays intact.
    while (JSON.stringify(copy).length > 2000000 && copy.activity.length) {
      const removed = copy.activity.shift();
      if (removed?.kind === "tool")
        copy.tools = copy.tools.filter(([id]) => id !== removed.id);
      copy.truncated = true;
    }
    this.entries = [
      copy,
      ...this.entries.filter((e) => e.id !== entry.id),
    ].slice(0, 30);
    while (
      JSON.stringify(this.entries).length * 2 > MAX_BYTES &&
      this.entries.length > 1
    )
      this.entries.pop();
    return this.persist();
  }
  remove(id: string) {
    this.entries = this.entries.filter((e) => e.id !== id);
    return this.persist();
  }
  private persist() {
    const value = JSON.parse(
      JSON.stringify({ version: 1, entries: this.entries }),
    );
    this.writes = this.writes.then(async () => {
      try {
        await this.storage?.set(this.key, value);
        this.error = "";
      } catch {
        this.error = "Conversation history could not be saved";
      }
    });
    return this.writes;
  }
}
