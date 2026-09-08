import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
let sessionId = "fixture-session";
const historyEnabled = process.argv.includes("--history");
const resumeOnly = process.argv.includes("--resume-only");
const historyPath = path.join(process.cwd(), ".fixture-acp-history.json");
let sessions = {};
if (historyEnabled && fs.existsSync(historyPath))
  sessions = JSON.parse(fs.readFileSync(historyPath, "utf8"));
const remember = () => {
  if (historyEnabled) fs.writeFileSync(historyPath, JSON.stringify(sessions));
};
const legacy = process.argv.includes("--legacy-config");
const modes = {
  currentModeId: "ask",
  availableModes: [
    { id: "ask", name: "Ask" },
    { id: "agent", name: "Agent" },
  ],
};
const models = {
  currentModelId: "model-high",
  availableModels: [
    { modelId: "model-high", name: "Model (high)" },
    { modelId: "fast", name: "Fast model" },
  ],
};
let configOptions = [
  {
    id: "approval_policy",
    name: "Permissions",
    category: "mode",
    type: "select",
    currentValue: "ask",
    options: [
      { value: "ask", name: "Ask" },
      { value: "agent", name: "Agent" },
    ],
  },
  {
    id: "collaboration_mode",
    name: "Session mode",
    type: "select",
    currentValue: "default",
    options: [
      { value: "default", name: "Default" },
      { value: "plan", name: "Plan" },
    ],
  },
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "model",
    options: [
      { value: "model", name: "Model" },
      { value: "fast", name: "Fast model" },
      { value: "unavailable", name: "Unavailable model" },
    ],
  },
  {
    id: "effort",
    name: "Reasoning",
    category: "thought_level",
    type: "select",
    currentValue: "high",
    options: [
      { value: "low", name: "Low" },
      { value: "high", name: "High" },
    ],
  },
  {
    id: "fast_mode",
    name: "Fast mode",
    type: "select",
    currentValue: "off",
    options: [
      { value: "off", name: "Off" },
      { value: "on", name: "On" },
    ],
  },
];
let sequence = 1000,
  promptId;
const pending = new Map();
const send = (message) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const call = (method, params) =>
  new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    send({ id, method, params: { sessionId, ...params } });
  });
const update = (update) =>
  send({ method: "session/update", params: { sessionId, update } });
readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  const message = JSON.parse(line),
    { id, method, params } = message;
  if (!method) {
    const waiter = pending.get(id);
    pending.delete(id);
    if (message.error) waiter?.reject(new Error(message.error.message));
    else waiter?.resolve(message.result);
    return;
  }
  if (method === "session/cancel") {
    for (const waiter of pending.values())
      waiter.resolve({ outcome: { outcome: "cancelled" } });
    pending.clear();
    if (promptId) send({ id: promptId, result: { stopReason: "cancelled" } });
    promptId = undefined;
    return;
  }
  try {
    let result = {};
    if (method === "initialize")
      result = {
        protocolVersion: 1,
        agentCapabilities: historyEnabled
          ? {
              loadSession: !resumeOnly,
              sessionCapabilities: { list: {}, resume: {} },
              promptCapabilities: { embeddedContext: true },
            }
          : {},
        agentInfo: { name: "fixture", title: "Fixture Agent", version: "1.0" },
        authMethods: [{ id: "fixture", name: "Fixture sign in" }],
      };
    else if (method === "session/new") {
      if (params.cwd !== process.cwd()) throw new Error("Wrong workspace");
      if (historyEnabled) {
        sessionId = randomUUID();
        sessions[sessionId] = { title: "New conversation", messages: [] };
        remember();
      }
      result = {
        sessionId,
        modes,
        models,
        ...(legacy ? {} : { configOptions }),
      };
    } else if (method === "session/list") {
      if (!historyEnabled || params.cwd !== process.cwd())
        throw new Error("Unsupported discovery");
      const all = Object.entries(sessions).map(([sessionId, s]) => ({
        sessionId,
        title: s.title,
        cwd: process.cwd(),
      }));
      const page = params.cursor ? 1 : 0;
      result = {
        sessions: [
          ...all.slice(page * 2, page * 2 + 2),
          {
            sessionId: "other",
            title: "Other workspace",
            cwd: "/different/workspace",
          },
        ],
        ...(all.length > page * 2 + 2 ? { nextCursor: "next" } : {}),
      };
    } else if (method === "session/load" || method === "session/resume") {
      if (!historyEnabled || !sessions[params.sessionId])
        throw new Error("Session missing");
      sessionId = params.sessionId;
      if (method === "session/load") {
        // Exercise history replay before the load response and distinct same-role messages.
        for (const [i, m] of sessions[sessionId].messages.entries())
          update({
            sessionUpdate: m.role + "_message_chunk",
            messageId: `replay-${i}`,
            content: { type: "text", text: m.text },
          });
        update({
          sessionUpdate: "session_info_update",
          title: sessions[sessionId].title,
        });
      }
      result = { modes, models, configOptions };
    } else if (method === "session/set_config_option") {
      const config = configOptions.find(
        (option) => option.id === params.configId,
      );
      if (!config?.options.some((option) => option.value === params.value))
        throw new Error("Invalid setting");
      await new Promise((resolve) => setTimeout(resolve, 300));
      if (params.value === "unavailable") throw new Error("Model unavailable");
      config.currentValue = params.value;
      if (config.id === "model") {
        const effort = configOptions.find((option) => option.id === "effort");
        effort.options =
          params.value === "fast"
            ? [{ value: "low", name: "Low" }]
            : [
                { value: "low", name: "Low" },
                { value: "high", name: "High" },
              ];
        effort.currentValue = params.value === "fast" ? "low" : "high";
      }
      result = { configOptions };
    } else if (method === "session/set_mode") {
      modes.currentModeId = params.modeId;
      update({
        sessionUpdate: "current_mode_update",
        currentModeId: params.modeId,
      });
    } else if (method === "session/set_model") {
      models.currentModelId = params.modelId;
    } else if (method === "session/prompt") {
      promptId = id;
      const text = params.prompt[0].text;
      if (historyEnabled) {
        sessions[sessionId].messages.push({ role: "user", text });
        sessions[sessionId].title = text.slice(0, 80);
        remember();
        update({
          sessionUpdate: "session_info_update",
          title: sessions[sessionId].title,
        });
      }
      if (text === "wait") return;
      if (text === "error") throw new Error("Fixture prompt failed");
      if (text === "config-update") {
        configOptions = configOptions.map((option) =>
          option.id === "collaboration_mode"
            ? { ...option, currentValue: "plan" }
            : option,
        );
        update({ sessionUpdate: "config_option_update", configOptions });
      }
      if (text === "crash") process.exit(7);
      if (text === "malformed") {
        process.stdout.write("bad ACP\n");
        return;
      }
      if (text === "oversized") {
        process.stdout.write("x".repeat(2 * 1024 * 1024 + 1));
        return;
      }
      update({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Hello from ACP. " },
      });
      update({
        sessionUpdate: "available_commands_update",
        availableCommands: [
          { name: "review", description: "Review workspace" },
        ],
      });
      update({
        sessionUpdate: "plan",
        entries: [
          {
            content: "Inspect workspace",
            status: "completed",
            priority: "medium",
          },
        ],
      });
      if (text === "context-inspect") {
        update({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: JSON.stringify(params.prompt) },
        });
      } else if (text === "rich") {
        update({
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "\n\n## Review result\n\nThe **editor snapshot** is ready.\n\n```ts\nconst ready = true;\n```\n\n[Open file](hello.txt#L1)\n\n<script>window.acpInjected=true</script>\n![tracking](https://invalid.example/pixel)",
          },
        });
        update({
          sessionUpdate: "tool_call",
          toolCallId: randomUUID(),
          title: "Inspect editor snapshot",
          status: "completed",
          kind: "read",
          rawOutput: "Verified snapshot",
        });
        update({
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "The check completed after the tool.",
          },
        });
      } else if (text.startsWith("read:")) {
        const file = await call("fs/read_text_file", {
          path: text.slice(5),
          line: 1,
          limit: 2,
        });
        update({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: file.content },
        });
      } else if (text.startsWith("write:")) {
        await call("fs/write_text_file", {
          path: text.slice(6),
          content: "agent edit\n",
        });
      } else if (text === "permission") {
        const decision = await call("session/request_permission", {
          toolCall: {
            toolCallId: "edit",
            title: "Edit hello.txt",
            rawInput: { path: "hello.txt" },
          },
          options: [
            { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
            { optionId: "reject-once", name: "Reject", kind: "reject_once" },
          ],
        });
        update({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: JSON.stringify(decision) },
        });
      } else if (text === "tools") {
        const terminal = await call("terminal/create", {
          command: process.execPath,
          args: ["-e", 'process.stdout.write("Terminal fixture ✓")'],
          outputByteLimit: 100,
        });
        const exit = await call("terminal/wait_for_exit", terminal),
          output = await call("terminal/output", terminal);
        update({
          sessionUpdate: "tool_call",
          toolCallId: "terminal",
          title: "Run fixture check",
          kind: "execute",
          status: "completed",
          content: [{ type: "terminal", terminalId: terminal.terminalId }],
          rawOutput: { ...output, ...exit },
        });
        await call("terminal/release", terminal);
      } else if (text === "questions") {
        const answer = await call("cursor/ask_question", {
          questions: [
            {
              id: "mode",
              prompt: "Choose a mode",
              options: [
                { id: "ask", label: "Ask" },
                { id: "agent", label: "Agent" },
              ],
            },
          ],
        });
        update({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: JSON.stringify(answer) },
        });
      } else if (text === "plan") {
        await call("cursor/create_plan", {
          name: "Fixture plan",
          plan: "1. Inspect\n2. Implement",
        });
      }
      update({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Done." },
      });
      if (historyEnabled) {
        sessions[sessionId].messages.push({ role: "agent", text: "Done." });
        remember();
      }
      result = { stopReason: "end_turn" };
      promptId = undefined;
    }
    send({ id, result });
  } catch (error) {
    send({ id, error: { code: -32603, message: error.message } });
  }
});
