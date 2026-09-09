import { describe, expect, it } from "vitest";
import { ConversationHistory, type Conversation } from "./history.js";
import type { ACPSubagent } from "@oxbit/sdk";
const conversation = (): Conversation => ({
  id: "conversation",
  sessionId: "root",
  root: "/workspace",
  provider: "codex",
  title: "Delegated work",
  updatedAt: new Date().toISOString(),
  draft: "Keep this draft",
  context: [],
  activity: [],
  tools: [],
});
const child = (id: number): ACPSubagent => ({
  id: `child:${id}`,
  rootSessionId: "root",
  sessionId: `${id}`,
  provider: "codex",
  name: "Reviewer",
  task: "Review",
  toolCallIds: [],
  state: "running",
  phase: "thinking",
  evidence: "native",
  visibility: "full",
  observedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  activity: [
    { kind: "message", role: "agent", id: "result", text: "x".repeat(16000) },
  ],
  result: "y".repeat(16000),
});
describe("subagent conversation history", () => {
  it("loads older v1 records without children and never interprets history as live", async () => {
    const history = new ConversationHistory(
      {
        get: async () => ({
          version: 1,
          entries: [
            conversation(),
            { ...conversation(), id: "children", subagents: [child(1)] },
          ],
        }),
      } as any,
      "history",
    );
    await history.ready;
    expect(history.entries[0].subagents).toEqual([]);
    expect(history.entries[1].subagents?.[0].historical).toBe(true);
  });
  it("bounds all child previews within the existing budget while retaining drafts", async () => {
    let value: any;
    const history = new ConversationHistory(
      {
        get: async () => undefined,
        set: async (_key: string, data: any) => {
          value = data;
        },
      } as any,
      "history",
    );
    await history.ready;
    const entry = {
      ...conversation(),
      subagents: Array.from({ length: 256 }, (_, i) => child(i)),
    };
    await history.save(entry);
    expect(JSON.stringify(value).length * 2).toBeLessThan(4 * 1024 * 1024);
    expect(value.entries[0].draft).toBe("Keep this draft");
    expect(value.entries[0].subagents).toHaveLength(256);
    expect(
      value.entries[0].subagents.some((c: ACPSubagent) => c.truncated),
    ).toBe(true);
    expect(
      value.entries[0].subagents.every((c: ACPSubagent) => c.historical),
    ).toBe(true);
    expect(entry.subagents[0].activity).toHaveLength(1);
    await history.remove(entry.id);
    expect(value.entries).toEqual([]);
  });
});
