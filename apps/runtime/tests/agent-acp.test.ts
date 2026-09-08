import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentACP } from "../src/agent-acp.js";
import { WorkspaceFiles } from "../src/filesystem.js";
const fixture = path.resolve("tests/fixtures/agent-acp/agent.mjs");
describe("ACP runtime bridge", () => {
  const cleanups: (() => Promise<unknown>)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });
  async function setup(args: string[] = []) {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "oxbit-acp-")),
    );
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const events: { owner: string; name: string; params: any }[] = [];
    const agent = new AgentACP(
      new WorkspaceFiles(root),
      (owner, name, params) => {
        events.push({ owner, name, params });
      },
    );
    cleanups.push(async () => agent.dispose());
    const connection = await agent.start("client", {
      provider: "codex",
      command: process.execPath,
      args: [fixture, ...args],
    });
    await agent.call("client", connection.id, "session/new");
    return { root, agent, connection, events };
  }
  it("streams messages, runs real bounded terminals and isolates clients", async () => {
    const { agent, connection, events } = await setup();
    await expect(
      agent.call("intruder", connection.id, "session/prompt", {
        text: "tools",
      }),
    ).rejects.toThrow("ended");
    expect(
      await agent.call("client", connection.id, "session/prompt", {
        text: "tools",
      }),
    ).toEqual({ stopReason: "end_turn" });
    expect(events.every((e) => e.owner === "client")).toBe(true);
    const terminal = events.findLast((e) => e.name === "acp.terminal")!;
    expect(terminal.params.output).toBe("Terminal fixture ✓");
    expect(terminal.params.exitStatus.exitCode).toBe(0);
    expect(
      events.some((e) => e.params.update?.sessionUpdate === "tool_call"),
    ).toBe(true);
  });
  it("serializes settings with prompts and returns dependent configuration", async () => {
    const { agent, connection } = await setup();
    const change = agent.call(
      "client",
      connection.id,
      "session/set_config_option",
      { configId: "model", value: "fast" },
    );
    await expect(
      agent.call("client", connection.id, "session/prompt", { text: "Hello" }),
    ).rejects.toThrow("current agent operation");
    await expect(
      agent.call("client", connection.id, "session/set_config_option", {
        configId: "effort",
        value: "high",
      }),
    ).rejects.toThrow("current agent operation");
    const result = await change;
    expect(
      result.configOptions.find((option: any) => option.id === "effort"),
    ).toMatchObject({
      currentValue: "low",
      options: [{ value: "low", name: "Low" }],
    });
    await expect(
      agent.call("client", connection.id, "session/set_config_option", {
        configId: "model",
        value: "unavailable",
      }),
    ).rejects.toThrow("Model unavailable");
    await expect(
      agent.call("client", connection.id, "session/prompt", { text: "Hello" }),
    ).resolves.toEqual({ stopReason: "end_turn" });
  });
  it("waits for explicit permission and rejects forged choices", async () => {
    const { agent, connection, events } = await setup();
    const turn = agent.call("client", connection.id, "session/prompt", {
      text: "permission",
    });
    await expect
      .poll(() => events.some((e) => e.name === "acp.request"))
      .toBe(true);
    const request = events.find((e) => e.name === "acp.request")!.params;
    expect(() =>
      agent.respond("client", connection.id, request.requestId, {
        outcome: { outcome: "selected", optionId: "invented" },
      }),
    ).toThrow("Invalid permission");
    agent.respond("client", connection.id, request.requestId, {
      outcome: { outcome: "selected", optionId: "reject-once" },
    });
    await turn;
    expect(
      events.some((e) =>
        e.params.update?.content?.text?.includes("reject-once"),
      ),
    ).toBe(true);
  });
  it("rejects filesystem escapes, including symlinks", async () => {
    const { agent, connection, root } = await setup();
    await expect(
      agent.call("client", connection.id, "session/prompt", {
        text: "read:/etc/passwd",
      }),
    ).rejects.toThrow("workspace");
    await fs.symlink(os.tmpdir(), path.join(root, "outside"));
    await expect(
      agent.call("client", connection.id, "session/prompt", {
        text: `read:${root}/outside/secret`,
      }),
    ).rejects.toThrow();
  });
  it("normalizes approved workspace file requests and forwards editor content", async () => {
    const { agent, connection, root, events } = await setup();
    await fs.writeFile(path.join(root, "hello.txt"), "disk");
    const turn = agent.call("client", connection.id, "session/prompt", {
      text: `read:${root}/hello.txt`,
    });
    await expect
      .poll(() => events.some((e) => e.name === "acp.request"))
      .toBe(true);
    const request = events.find((e) => e.name === "acp.request")!.params;
    expect(request.params.path).toBe("hello.txt");
    agent.respond("client", connection.id, request.requestId, {
      content: "unsaved editor text",
    });
    await turn;
    expect(
      events.some((e) =>
        e.params.update?.content?.text?.includes("unsaved editor text"),
      ),
    ).toBe(true);
  });
  it("cancels prompts and terminates sessions on disconnect", async () => {
    const { agent, connection } = await setup();
    const turn = agent.call("client", connection.id, "session/prompt", {
      text: "wait",
    });
    await expect(
      agent.call("client", connection.id, "session/prompt", {
        text: "duplicate",
      }),
    ).rejects.toThrow("current agent operation");
    agent.cancel("client", connection.id);
    expect(await turn).toEqual({ stopReason: "cancelled" });
    const next = agent.call("client", connection.id, "session/prompt", {
      text: "wait",
    });
    agent.disconnect("client");
    await expect(next).rejects.toThrow("disconnected");
    await expect(
      agent.call("client", connection.id, "session/new"),
    ).rejects.toThrow("ended");
  });
  it.each(["crash", "malformed", "oversized"])(
    "fails pending calls when an agent sends %s",
    async (text) => {
      const { agent, connection } = await setup();
      await expect(
        agent.call("client", connection.id, "session/prompt", { text }),
      ).rejects.toThrow();
      await expect(
        agent.call("client", connection.id, "session/new"),
      ).rejects.toThrow("ended");
    },
  );
  it("does not launch unknown providers or missing executables", async () => {
    const { agent } = await setup();
    await expect(
      agent.start("client", { provider: "unknown" as any }),
    ).rejects.toThrow("Choose");
    await expect(
      agent.start("client", { provider: "amp", command: "/missing/oxbit-acp" }),
    ).rejects.toThrow("Could not launch");
  });
  it("discovers workspace sessions, restores replay before the response, and continues after a process restart", async () => {
    const { root, agent, connection, events } = await setup(["--history"]);
    const first = connection.sessionId;
    await agent.call("client", connection.id, "session/prompt", {
      text: "First conversation",
    });
    await agent.call("client", connection.id, "session/new");
    await agent.call("client", connection.id, "session/new");
    const page = await agent.call("client", connection.id, "session/list");
    expect(page.sessions).toHaveLength(2);
    expect(page.sessions.every((s: any) => s.cwd === root)).toBe(true);
    expect(page.nextCursor).toBe("next");
    expect(
      (
        await agent.call("client", connection.id, "session/list", {
          cursor: page.nextCursor,
        })
      ).sessions,
    ).toHaveLength(1);
    agent.stop("client", connection.id);
    const resumed = await agent.start("client", {
      provider: "codex",
      command: process.execPath,
      args: [fixture, "--history"],
    });
    const from = events.length;
    await agent.call("client", resumed.id, "session/load", {
      sessionId: first,
    });
    expect(
      events
        .slice(from)
        .filter((e) => e.name === "acp.update")
        .map((e) => e.params.update.content?.text)
        .filter(Boolean),
    ).toEqual(["First conversation", "Done."]);
    expect(resumed.sessionId).toBe(first);
    await agent.call("client", resumed.id, "session/prompt", {
      text: "Continue",
    });
    const records = JSON.parse(
      await fs.readFile(path.join(root, ".fixture-acp-history.json"), "utf8"),
    );
    expect(
      records[first!].messages
        .filter((m: any) => m.role === "user")
        .map((m: any) => m.text),
    ).toEqual(["First conversation", "Continue"]);
    await expect(
      agent.call("client", resumed.id, "session/load", {
        sessionId: "missing",
      }),
    ).rejects.toThrow("missing");
    expect(resumed.sessionId).toBe(first);
  });
  it("gates lifecycle methods by capabilities and supports resume without replay", async () => {
    const unsupported = await setup();
    for (const method of ["session/load", "session/resume", "session/list"])
      await expect(
        unsupported.agent.call("client", unsupported.connection.id, method, {
          sessionId: "session",
        }),
      ).rejects.toThrow("does not support");
    const { agent, connection, events } = await setup([
      "--history",
      "--resume-only",
    ]);
    await expect(
      agent.call("client", connection.id, "session/load", {
        sessionId: connection.sessionId,
      }),
    ).rejects.toThrow("does not support");
    const before = events.length;
    await agent.call("client", connection.id, "session/resume", {
      sessionId: connection.sessionId,
    });
    expect(events.length).toBe(before);
  });
  it.each([false, true])(
    "sends snapshot context with negotiated embedded support %s and rejects escaping paths",
    async (embedded) => {
      const { root, agent, connection, events } = await setup(
        embedded ? ["--history"] : [],
      );
      await fs.writeFile(path.join(root, "hello.txt"), "disk");
      await agent.call("client", connection.id, "session/prompt", {
        text: "context-inspect",
        context: [
          {
            path: "hello.txt",
            text: "unsaved snapshot",
            line: 2,
            label: "hello.txt:2-2",
          },
        ],
      });
      const response = events.find((e) =>
        e.params.update?.content?.text?.startsWith('[{"type":"text"'),
      )!;
      const content = JSON.parse(response.params.update.content.text);
      expect(content[0]).toEqual({ type: "text", text: "context-inspect" });
      expect(content[1].type).toBe(embedded ? "resource" : "text");
      expect(JSON.stringify(content[1])).toContain("unsaved snapshot");
      if (embedded) expect(content[1].resource.uri).toContain("hello.txt#L2");
      await expect(
        agent.call("client", connection.id, "session/prompt", {
          text: "context-inspect",
          context: [{ path: "../secret", text: "do not send" }],
        }),
      ).rejects.toThrow();
    },
  );
});
