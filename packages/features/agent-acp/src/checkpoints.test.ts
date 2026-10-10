import { afterEach, describe, expect, it, vi } from "vitest";
import { CHECKPOINT_TIMEOUT, Checkpoints, carryCheckpoints } from "./checkpoints.js";
import { ConversationHistory, type Activity, type Message } from "./history.js";

const user = (text: string, checkpoint?: string): Activity => ({
  kind: "message", message: { role: "user", text, ...(checkpoint ? { checkpoint } : {}) },
});
afterEach(() => vi.useRealTimers());

describe("checkpoints", () => {
  it("resolves without a checkpoint after the timeout", async () => {
    vi.useFakeTimers();
    const checkpoints = new Checkpoints(() => new Promise(() => {}), () => {}, () => []);
    const created = checkpoints.create();
    await vi.advanceTimersByTimeAsync(CHECKPOINT_TIMEOUT);
    await expect(created).resolves.toBeUndefined();
  });
  it("shows a restore only when the current files differ from the checkpoint", async () => {
    const messages: Message[] = [{ role: "user", text: "One", checkpoint: "a" }];
    const request = vi.fn(async () => ({ tree: "a" }) as any);
    const checkpoints = new Checkpoints(request, () => {}, () => messages);
    checkpoints.refresh();
    await vi.waitFor(() => expect(checkpoints.current).toBe("a"));
    expect(checkpoints.differs(messages[0]!)).toBe(false);
    request.mockResolvedValueOnce({ tree: "b" });
    checkpoints.refresh();
    await vi.waitFor(() => expect(checkpoints.differs(messages[0]!)).toBe(true));
    request.mockResolvedValueOnce({ unavailable: "not-repository" });
    checkpoints.refresh();
    await vi.waitFor(() => expect(checkpoints.differs(messages[0]!)).toBe(false));
  });
  it("carries saved checkpoints onto replayed user messages in order", () => {
    const replayed = [user("Same"), { kind: "notice", text: "x" } as Activity, user("Other"), user("Same")];
    carryCheckpoints([user("Same", "one"), user("Other", "two"), user("Same", "three")], replayed);
    expect(replayed.map((entry) => entry.kind === "message" && entry.message.checkpoint)).toEqual(["one", false, "two", "three"]);
  });
  it("keeps the checkpoint in saved history", async () => {
    const store = new Map<string, unknown>();
    const persistence = { get: async (key: string) => store.get(key), set: async (key: string, value: unknown) => void store.set(key, value) };
    const history = new ConversationHistory(persistence as any, "history");
    await history.ready;
    await history.save({
      id: "c", sessionId: "s", root: "/workspace", provider: "codex", title: "t", updatedAt: "", draft: "",
      context: [], tools: [], activity: [user("Edit", "c".repeat(40))],
    });
    const reloaded = new ConversationHistory(persistence as any, "history");
    await reloaded.ready;
    expect(reloaded.entries[0]!.activity[0]).toEqual(user("Edit", "c".repeat(40)));
  });
});
