// Deterministic ACP subprocess: no credentials, model requests, or external tools.
import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
let root = "root-1",
  sequence = 1000,
  nextRoot = 1;
const savedPath = path.join(process.cwd(), ".subagents-history.json");
let saved = fs.existsSync(savedPath)
  ? JSON.parse(fs.readFileSync(savedPath, "utf8"))
  : {};
nextRoot = Object.keys(saved).length + 1;
const pending = new Map();
const send = (value) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
const call = (method, params) =>
  new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    send({ id, method, params });
  });
const update = (sessionId, update, save = true) => {
  const params = { sessionId, update };
  if (save) {
    (saved[root] ??= []).push(params);
    fs.writeFileSync(savedPath, JSON.stringify(saved));
  }
  send({ method: "session/update", params });
};
const spawn = (id, name, parent = root) =>
  update(parent, {
    sessionUpdate: "subagent_spawned",
    subagentSessionId: id,
    name,
    task: `Inspect ${name.toLowerCase()} behavior`,
    capabilities: {},
  });
const finish = (id, state = "completed", parent = root) =>
  update(parent, {
    sessionUpdate: "subagent_state_update",
    subagentSessionId: id,
    state,
  });
const text = (sessionId, value, thought = false) =>
  update(sessionId, {
    sessionUpdate: thought ? "agent_thought_chunk" : "agent_message_chunk",
    messageId: `${sessionId}:${++sequence}`,
    content: { type: "text", text: value },
  });
async function background() {
  try {
    const permission = await call("session/request_permission", {
      sessionId: "reviewer",
      toolCall: {
        toolCallId: "review",
        title: "Review delegated change",
        kind: "edit",
        status: "pending",
      },
      options: [
        { optionId: "allow", name: "Allow once", kind: "allow_once" },
        { optionId: "deny", name: "Reject", kind: "reject_once" },
      ],
    });
    if (permission.outcome?.optionId !== "allow") {
      finish("reviewer", "cancelled");
      return;
    }
    await call("fs/write_text_file", {
      sessionId: "reviewer",
      path: path.join(process.cwd(), "hello.txt"),
      content: "reviewed by child\n",
    });
    text("reviewer", "## Review complete\nThe delegated edit was applied.");
    finish("reviewer");
  } catch (error) {
    text("reviewer", String(error));
    finish("reviewer", "failed");
  }
}
readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  const { id, method, params = {}, result, error } = JSON.parse(line);
  if (!method) {
    const entry = pending.get(id);
    pending.delete(id);
    if (error) entry?.reject(new Error(error.message));
    else entry?.resolve(result);
    return;
  }
  try {
    if (method === "initialize") {
      send({
        id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: "subagents-fixture", version: "1" },
          authMethods: [],
          agentCapabilities: {
            loadSession: true,
            sessionCapabilities: { subagents: {}, list: {} },
          },
          _meta: { requestedSubagents: params.clientCapabilities?.subagents },
        },
      });
      return;
    }
    if (method === "session/new") {
      root = `root-${nextRoot++}`;
      saved[root] = [];
      send({ id, result: { sessionId: root } });
      return;
    }
    if (method === "session/load") {
      if (!saved[params.sessionId]) throw new Error("Session not found");
      root = params.sessionId;
      for (const data of saved[root])
        send({ method: "session/update", params: data });
      send({ id, result: {} });
      return;
    }
    if (method === "session/list") {
      send({
        id,
        result: {
          sessions: Object.keys(saved).map((sessionId) => ({
            sessionId,
            cwd: process.cwd(),
            title: "Delegated work",
          })),
        },
      });
      return;
    }
    if (method === "session/cancel") {
      finish("reviewer", "cancelled");
      return;
    }
    if (method !== "session/prompt") {
      send({ id, error: { code: -32601, message: "Unsupported" } });
      return;
    }
    const prompt = params.prompt[0].text;
    if (prompt === "delegate") {
      spawn("reviewer", "Reviewer");
      spawn("tests", "Test runner", "reviewer");
      spawn("audit", "Audit");
      text("reviewer", "Checking the current editor snapshot.", true);
      text("tests", "Child-only test output");
      finish("tests", "completed", "reviewer");
      text("audit", "The optional check failed.");
      finish("audit", "failed");
      text(root, "Delegated the review. The reviewer may need your input.");
      send({ id, result: { stopReason: "end_turn" } });
      setTimeout(() => void background(), 30);
      return;
    }
    if (prompt === "isolation") {
      spawn("one", "One");
      spawn("two", "Two");
      const report = {};
      const capture = async (name, operation) => {
        try {
          report[name] = await operation();
        } catch (e) {
          report[name] = String(e);
        }
      };
      await capture("foreign", () =>
        call("fs/read_text_file", {
          sessionId: "intruder",
          path: path.join(process.cwd(), "hello.txt"),
        }),
      );
      const term = await call("terminal/create", {
        sessionId: "one",
        command: process.execPath,
        args: ["-e", "process.stdout.write('child terminal')"],
      });
      await call("terminal/wait_for_exit", {
        sessionId: "one",
        terminalId: term.terminalId,
      });
      await capture("siblingTerminal", () =>
        call("terminal/output", {
          sessionId: "two",
          terminalId: term.terminalId,
        }),
      );
      await capture("ownerTerminal", () =>
        call("terminal/output", {
          sessionId: "one",
          terminalId: term.terminalId,
        }),
      );
      await capture("outside", () =>
        call("fs/write_text_file", {
          sessionId: "two",
          path: path.resolve(process.cwd(), "../escape"),
          content: "no",
        }),
      );
      const content = await call("fs/read_text_file", {
        sessionId: "one",
        path: path.join(process.cwd(), "hello.txt"),
      });
      report.read = content.content;
      await capture("parallelWrite", () =>
        Promise.all(
          ["one", "two"].map((sessionId) =>
            call("fs/write_text_file", {
              sessionId,
              path: path.join(process.cwd(), "hello.txt"),
              content: sessionId,
            }),
          ),
        ),
      );
      text(root, JSON.stringify(report));
      finish("one");
      finish("two");
    } else if (prompt === "amp") {
      update(root, {
        sessionUpdate: "tool_call",
        toolCallId: "amp-task",
        title: "Task: Find references",
        kind: "think",
        rawInput: {
          description: "Find references",
          prompt: "Inspect editor references",
        },
        status: "pending",
      });
      update(root, {
        sessionUpdate: "tool_call_update",
        toolCallId: "amp-task",
        status: "completed",
        content: [
          {
            type: "content",
            content: { type: "text", text: "Found the references" },
          },
        ],
      });
    } else if (prompt === "cursor") {
      update(root, {
        sessionUpdate: "tool_call",
        toolCallId: "cursor-task",
        title: "Explore",
        status: "in_progress",
      });
      send({
        method: "cursor/task",
        params: {
          toolCallId: "cursor-task",
          description: "Explore",
          prompt: "Find the implementation",
          subagentType: "explore",
        },
      });
      update(root, {
        sessionUpdate: "tool_call_update",
        toolCallId: "cursor-task",
        status: "completed",
        rawOutput: {
          outcome: {
            outcome: "completed",
            agentId: "cursor-child",
            durationMs: 75,
          },
          result: "Found it",
        },
      });
    } else if (prompt === "cancel-child") finish("reviewer", "cancelled");
    else text(root, "Continued without dispatching another agent.");
    send({ id, result: { stopReason: "end_turn" } });
  } catch (error) {
    send({ id, error: { code: -32000, message: String(error) } });
  }
});
