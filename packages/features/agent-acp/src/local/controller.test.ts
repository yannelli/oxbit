import { describe, expect, it, vi } from "vitest";
import type { FeatureOptions } from "@oxbit/sdk";
import { AgentController } from "../controller.js";
import { sessionControls } from "../session-controls.js";
import { LocalAgentRuntime } from "./runtime.js";
import { chatText, chatTool, fakeModels, hanging, settings, type Reply } from "./test-models.js";

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
    filesystem: { id: "fs", root: "/workspace", list: vi.fn(async () => []), write: vi.fn(async () => ({})) },
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
  const agent = new AgentController({ ...options, runtime: new LocalAgentRuntime(options, () => fake.models) });
  return { agent, files, fake };
}

describe("AgentController with LocalAgentRuntime", () => {
  it("connects, reviews an edit through the write card and finishes the turn", async () => {
    const { agent, files } = setup([chatTool("call_1", "edit_file", { path: "a.ts", old_string: "a = 1", new_string: "a = 2" }), chatText("Done")]);
    await agent.connect({ provider: "oxbit" });
    expect(agent.connection).toEqual(expect.objectContaining({ provider: "oxbit", name: "Oxbit Agent", root: "/workspace", sessionId: expect.any(String) }));
    expect(sessionControls(agent.connection).map((control) => [control.id, control.value])).toEqual([["model", "model-a"], ["reasoning", "default"]]);
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
});
