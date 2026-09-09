import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentACP } from "../src/agent-acp.js";
import { WorkspaceFiles } from "../src/filesystem.js";
import type { ACPProviderId } from "@oxbit/sdk";
const fixture = path.resolve("tests/fixtures/agent-acp/subagents.mjs");
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function setup(provider: ACPProviderId = "codex") {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "oxbit-subagent-")),
  );
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "hello.txt"), "disk");
  const events: { owner: string; name: string; params: any }[] = [];
  const agent = new AgentACP(new WorkspaceFiles(root), (owner, name, params) =>
    events.push({ owner, name, params }),
  );
  cleanups.push(async () => agent.dispose());
  const connection = await agent.start("client", {
    provider,
    command: process.execPath,
    args: [fixture],
  });
  await agent.call("client", connection.id, "session/new");
  const prompt = (text: string) =>
    agent.call("client", connection.id, "session/prompt", { text });
  return { root, agent, connection, events, prompt };
}
describe("subagent subprocess integration", () => {
  it("keeps child approvals alive after the parent finishes and blocks switching", async () => {
    const { agent, connection, events, prompt } = await setup();
    await prompt("delegate");
    await expect
      .poll(() => events.some((e) => e.name === "acp.request"))
      .toBe(true);
    const request = events.find((e) => e.name === "acp.request")!.params;
    expect(request).toMatchObject({
      sessionId: "reviewer",
      subagentId: "codex:reviewer",
    });
    await expect(
      agent.call("client", connection.id, "session/new"),
    ).rejects.toThrow("active subagents");
    expect(() =>
      agent.respond("intruder", connection.id, request.requestId, {}),
    ).toThrow("ended");
    agent.respond("client", connection.id, request.requestId, {
      outcome: { outcome: "selected", optionId: "allow" },
    });
    await expect
      .poll(() =>
        events.some(
          (e) =>
            e.name === "acp.request" &&
            e.params.method === "fs/write_text_file",
        ),
      )
      .toBe(true);
    const write = events.find(
      (e) =>
        e.name === "acp.request" && e.params.method === "fs/write_text_file",
    )!.params;
    agent.respond("client", connection.id, write.requestId, {});
    await expect
      .poll(
        () =>
          events.findLast((e) => e.name === "acp.subagent")?.params.activeCount,
      )
      .toBe(0);
    const child = events.findLast(
      (e) =>
        e.name === "acp.subagent" && e.params.subagent.id === "codex:reviewer",
    )!.params.subagent;
    expect(child).toMatchObject({
      state: "completed",
      result: expect.stringContaining("Review complete"),
    });
    await agent.call("client", connection.id, "session/new");
  });
  it("isolates terminals and paths while attributing concurrent child requests", async () => {
    const { agent, connection, events, prompt } = await setup();
    const turn = prompt("isolation");
    const handled = new Set<string>();
    const timer = setInterval(() => {
      for (const event of events)
        if (
          event.name === "acp.request" &&
          !handled.has(event.params.requestId)
        ) {
          handled.add(event.params.requestId);
          agent.respond(
            "client",
            connection.id,
            event.params.requestId,
            event.params.method === "fs/read_text_file"
              ? { content: "editor snapshot" }
              : {},
          );
        }
    }, 5);
    try {
      await turn;
    } finally {
      clearInterval(timer);
    }
    const report = JSON.parse(
      events.find((e) =>
        e.params.update?.content?.text?.startsWith('{"foreign"'),
      )!.params.update.content.text,
    );
    expect(report.foreign).toContain("Unknown ACP session");
    expect(report.siblingTerminal).toContain("Unknown agent terminal");
    expect(report.ownerTerminal.output).toBe("child terminal");
    expect(report.outside).toContain("Error");
    expect(report.read).toBe("editor snapshot");
    expect(
      events
        .filter(
          (e) =>
            e.name === "acp.request" &&
            e.params.method === "fs/write_text_file",
        )
        .map((e) => e.params.subagentId)
        .sort(),
    ).toEqual(["codex:one", "codex:two"]);
    expect(events.every((e) => e.owner === "client")).toBe(true);
    expect(
      events.some(
        (e) => e.name === "acp.terminal" && e.params.sessionId === "one",
      ),
    ).toBe(true);
  });
  it.each(["cursor", "amp"] as const)(
    "normalizes %s through the real transport",
    async (provider) => {
      const { events, prompt } = await setup(provider);
      await prompt(provider);
      const event = events.findLast((e) => e.name === "acp.subagent")!;
      expect(event.params.subagent.visibility).toBe("limited");
      expect(event.params.subagent.state).toBe(
        provider === "cursor" ? "completed" : "unknown",
      );
      expect(event.params.activeCount).toBe(0);
    },
  );
  it("expires child requests on an explicit child end and preserves historical replay", async () => {
    const { agent, connection, events, prompt } = await setup();
    await prompt("delegate");
    await expect
      .poll(() => events.some((e) => e.name === "acp.request"))
      .toBe(true);
    const request = events.find((e) => e.name === "acp.request")!.params;
    await prompt("cancel-child");
    expect(() =>
      agent.respond("client", connection.id, request.requestId, {}),
    ).toThrow("expired");
    const sessionId = connection.sessionId;
    await agent.call("client", connection.id, "session/load", { sessionId });
    expect(
      events.findLast((e) => e.name === "acp.subagent")!.params.subagent
        .historical,
    ).toBe(true);
    expect(
      events.findLast((e) => e.name === "acp.subagent")!.params.activeCount,
    ).toBe(0);
  });
});
