import { describe, expect, it, vi } from "vitest";
import type { FeatureOptions } from "@oxbit/sdk";
import { AgentController } from "../controller.js";
import { sessionControls } from "../session-controls.js";
import { LocalAgentRuntime } from "./runtime.js";
import { chatText, chatTool, fakeModels, hanging, settings, type Reply } from "@oxbit/agent-core/test-models";

function document(value: string) {
  const doc = {
    value, dirty: false, state: "ready", version: 1, savedRevision: "r1",
    text: { toString: () => doc.value },
    replace: vi.fn((text: string) => {
      doc.value = text;
      doc.version++;
    }),
  };
  return doc;
}
function setup(replies: Reply[]) {
  const files = new Map([["a.ts", document("const a = 1;\n")]]);
  const options = {
    filesystem: { id: "fs", root: "/workspace", list: vi.fn(async () => []), write: vi.fn(async () => ({})),
      read: vi.fn(async (path: string) => ({ text: files.get(path)!.value, revision: "r1" })) },
    documents: {
      get: (path: string) => files.get(path),
      open: vi.fn(async (path: string) => {
        const file = files.get(path);
        if (!file) throw Object.assign(new Error("Missing"), { code: "ENOENT" });
        return file;
      }),
      save: vi.fn(async () => {}),
    },
    workbench: { openFile: vi.fn(), refreshFiles: vi.fn(), notify: vi.fn(), activePath: () => undefined, activeEditor: () => undefined },
    kernel: { configuration: settings(), services: { optional: () => undefined, get: () => undefined } },
  } as unknown as FeatureOptions;
  const fake = fakeModels(replies);
  const runtime = new LocalAgentRuntime(options, () => fake.models);
  const agent = new AgentController({ ...options, runtime });
  return { agent, files, fake, runtime };
}

describe("AgentController with LocalAgentRuntime", () => {
  it("connects, reviews an edit through the write card and finishes the turn", async () => {
    const { agent, files } = setup([chatTool("call_1", "edit_file", { path: "a.ts", old_string: "a = 1", new_string: "a = 2" }), chatText("Done")]);
    await agent.connect({ provider: "oxbit" });
    expect(agent.connection).toEqual(expect.objectContaining({ provider: "oxbit", name: "Oxbit Agent", root: "/workspace", sessionId: expect.any(String) }));
    expect(sessionControls(agent.connection).map((control) => [control.id, control.value])).toEqual([["model", "model-a"], ["reasoning", "default"], ["mode", "ask"],
      ["auto-compact", "on"], ["compact-at", "default"]]);
    agent.draft = "Change a to 2";
    const sending = agent.send();
    await expect.poll(() => agent.requests.length).toBe(1);
    expect(agent.requests[0]).toEqual(expect.objectContaining({ method: "fs/write_text_file", before: "const a = 1;\n", params: expect.objectContaining({ path: "a.ts", content: "const a = 2;\n" }) }));
    await agent.applyFile(agent.requests[0]);
    await sending;
    expect(files.get("a.ts")!.value).toBe("const a = 2;\n");
    expect(agent.messages.map((message) => [message.role, message.text])).toEqual([["user", "Change a to 2"], ["agent", "Done"]]);
    expect(agent.tools.get("call_1")).toEqual(expect.objectContaining({ status: "completed", kind: "edit",
      locations: [{ path: "/workspace/a.ts" }], content: [expect.objectContaining({ type: "diff", path: "/workspace/a.ts", newText: "const a = 2;\n" })] }));
    expect(agent.changes).toHaveLength(1);
    expect(agent.status).toBe("Ready");
    agent.dispose();
  });
  it("/undo reverts the latest turn's applied edits, then the turn before", async () => {
    const edit = (id: string, from: string, to: string) => chatTool(id, "edit_file", { path: "a.ts", old_string: from, new_string: to });
    const { agent, files } = setup([edit("call_1", "a = 1", "a = 2"), chatText("One"), edit("call_2", "a = 2", "a = 3"), chatText("Two")]);
    await agent.connect({ provider: "oxbit" });
    for (const prompt of ["Change a to 2", "Change a to 3"]) {
      agent.draft = prompt;
      const sending = agent.send();
      await expect.poll(() => agent.requests.length).toBe(1);
      await agent.applyFile(agent.requests[0]);
      await sending;
    }
    expect(files.get("a.ts")!.value).toBe("const a = 3;\n");
    expect(agent.commands.map((command) => command.name)).toContain("undo");
    const undo = async () => {
      agent.draft = "/undo";
      await agent.send();
      expect(agent.draft).toBe("");
    };
    await undo();
    expect(files.get("a.ts")!.value).toBe("const a = 2;\n");
    await undo();
    expect(files.get("a.ts")!.value).toBe("const a = 1;\n");
    await undo();
    expect(agent.activity.at(-1)).toEqual({ kind: "notice", text: "No agent edits to undo." });
    expect(agent.messages.filter((message) => message.role === "user").map((message) => message.text)).toEqual(["Change a to 2", "Change a to 3"]);
    agent.dispose();
  });
  it("stops a streaming turn from the controller", async () => {
    const { agent } = setup([hanging(chatText("Partial").slice(0, 1))]);
    await agent.connect({ provider: "oxbit" });
    agent.draft = "Go";
    const sending = agent.send();
    await expect.poll(() => agent.messages.at(-1)?.text).toBe("Partial");
    await agent.cancel();
    await sending;
    expect(agent.busy).toBe(false);
    expect(agent.status).toBe("Stopped");
    agent.dispose();
  });
  it("runs a task subagent whose write carries its id and child session, then completes with the child's result", async () => {
    const { agent, files, fake } = setup([chatTool("t1", "task", { description: "Bump a", prompt: "Change a to 2 in a.ts" }),
      chatTool("c1", "edit_file", { path: "a.ts", old_string: "a = 1", new_string: "a = 2" }), chatText("Changed"), chatText("Done")]);
    await agent.connect({ provider: "oxbit" });
    agent.draft = "Delegate the change";
    const sending = agent.send();
    await expect.poll(() => agent.requests.length).toBe(1);
    const [child] = [...agent.subagents.values()];
    expect(child).toEqual(expect.objectContaining({ provider: "oxbit", name: "Bump a", task: "Change a to 2 in a.ts", state: "running",
      sessionId: expect.any(String), rootSessionId: agent.connection!.sessionId }));
    expect(child.sessionId).not.toBe(agent.connection!.sessionId);
    expect(agent.activeSubagentCount).toBe(1);
    expect(agent.requests[0]).toEqual(expect.objectContaining({ method: "fs/write_text_file", subagentId: child.id, sessionId: child.sessionId,
      params: expect.objectContaining({ path: "a.ts", content: "const a = 2;\n" }) }));
    await agent.applyFile(agent.requests[0]);
    await sending;
    expect(files.get("a.ts")!.value).toBe("const a = 2;\n");
    expect(agent.subagents.get(child.id)).toEqual(expect.objectContaining({ state: "completed", result: expect.stringContaining("Changed") }));
    expect(agent.activeSubagentCount).toBe(0);
    expect(agent.activity.filter((entry) => entry.kind === "subagent")).toEqual([{ kind: "subagent", id: child.id }]);
    expect(agent.messages.map((message) => [message.role, message.text])).toEqual([["user", "Delegate the change"], ["agent", "Done"]]);
    const bodies = fake.requests.filter((request) => request.method === "POST").map((request) => request.body as any);
    expect(bodies[1].tools.map((tool: any) => tool.function.name)).not.toContain("task");
    agent.draft = "/undo";
    await agent.send();
    expect(files.get("a.ts")!.value).toBe("const a = 1;\n");
    agent.dispose();
  });
  it("cancelling during a child's pending write expires the request and cancels the subagent", async () => {
    const { agent, files, runtime } = setup([chatTool("t1", "task", { description: "Bump a", prompt: "Change a to 2 in a.ts" }),
      chatTool("c1", "edit_file", { path: "a.ts", old_string: "a = 1", new_string: "a = 2" })]);
    await agent.connect({ provider: "oxbit" });
    const expired: string[] = [];
    runtime.subscribe("acp.requestsExpired", ({ requestIds }) => expired.push(...requestIds));
    agent.draft = "Delegate the change";
    const sending = agent.send();
    await expect.poll(() => agent.requests.length).toBe(1);
    const [child] = [...agent.subagents.values()];
    const { requestId } = agent.requests[0];
    await agent.cancel();
    await sending;
    expect(expired).toEqual([requestId]);
    expect(agent.requests).toEqual([]);
    await expect.poll(() => agent.subagents.get(child.id)?.state).toBe("cancelled");
    expect(agent.activeSubagentCount).toBe(0);
    expect(files.get("a.ts")!.value).toBe("const a = 1;\n");
    expect(agent.busy).toBe(false);
    agent.dispose();
  });
});
