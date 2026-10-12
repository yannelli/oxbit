import type { HostCapabilities } from "./host.js";
import type { AgentTool, Params, ToolContext } from "./extensions.js";
import type { ToolCall, ToolResult } from "./model.js";

const OUTPUT_LIMIT = 100000;
const BASH_TIMEOUT = 120000;
const BASH_MAX_TIMEOUT = 600000;
const path = { type: "string", description: "Path relative to the workspace root" };
const object = (properties: Params, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });

/** Resolves a workspace-relative path. Throws for absolute paths and paths that leave the root. */
export function resolvePath(root: string, input: unknown) {
  if (input === undefined || input === "") return { relative: "", absolute: root };
  if (typeof input !== "string" || input.includes("\0") || input.includes("\\"))
    throw new Error("Use a workspace-relative path");
  if (input.startsWith("/")) throw new Error(`Use a path relative to the workspace root: ${input}`);
  const parts: string[] = [];
  for (const part of input.split("/")) {
    if (part === ".." && !parts.length) throw new Error(`This path is outside the workspace: ${input}`);
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  const relative = parts.join("/");
  return { relative, absolute: relative ? `${root}/${relative}` : root };
}

/** The workspace-relative form of an absolute ACP path under `root`. */
export function relativePath(root: string, absolute: unknown) {
  if (typeof absolute !== "string" || !absolute.startsWith(root + "/"))
    throw new Error("ACP paths must be absolute workspace paths");
  const { relative } = resolvePath(root, absolute.slice(root.length + 1));
  if (!relative) throw new Error("ACP paths must be absolute workspace paths");
  return relative;
}

const lineArg = (args: Params, key: string) => {
  const value = args[key];
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new Error(`${key} must be a positive integer`);
  return value as number | undefined;
};
const string = (args: Params, key: string, empty = true) => {
  if (typeof args[key] !== "string" || (!empty && !args[key])) throw new Error(`${key} must be a${empty ? "" : " non-empty"} string`);
  return args[key] as string;
};
const clip = (text: string) => text.length > OUTPUT_LIMIT ? `${text.slice(0, OUTPUT_LIMIT)}\n[Truncated at ${OUTPUT_LIMIT} characters. Read a line range.]` : text;
const occurrences = (text: string, find: string) => text.split(find).length - 1;

const file = (context: ToolContext, args: Params) => {
  const resolved = resolvePath(context.root, string(args, "path", false));
  if (!resolved.relative) throw new Error("Choose a file inside the workspace");
  return resolved;
};
const read = async (context: ToolContext, absolute: string) =>
  (await context.request("fs/read_text_file", { sessionId: context.sessionId, toolCallId: context.toolCallId, path: absolute })).content as string;
const write = async (context: ToolContext, args: Params, absolute: string, oldText: string | null, newText: string) => {
  const { sessionId, toolCallId } = context;
  context.update({ sessionUpdate: "tool_call_update", toolCallId, content: [{ type: "diff", path: absolute, oldText, newText }] });
  const mark = context.mode === "ask" ? {} : { _meta: { oxbit: { mode: context.mode } } };
  await context.request("fs/write_text_file", { sessionId, toolCallId, path: absolute, content: newText, ...mark });
  return `Saved ${args.path}`;
};

export const listFiles: AgentTool = {
  spec: { name: "list_files", description: "List one workspace directory. Directory names end with /.",
    parameters: object({ path: { ...path, description: "Directory relative to the workspace root; omit for the root" } }) },
  kind: "read",
  title: (args) => `List ${args.path || "."}`,
  async run(args, context) {
    const entries = await context.filesystem.list(resolvePath(context.root, args.path).relative);
    const names = entries.slice(0, 500).map((entry) => entry.path + (entry.kind === "directory" ? "/" : ""));
    return names.join("\n") + (entries.length > 500 ? `\n[${entries.length - 500} more entries]` : "") || "The directory is empty";
  },
};
export const search: AgentTool = {
  spec: { name: "search", description: "Search file contents in the workspace. Returns path:line: text matches.",
    parameters: object({ query: { type: "string" }, regex: { type: "boolean" }, case_sensitive: { type: "boolean" },
      include: { type: "string", description: "Comma-separated globs, for example src/**/*.ts" } }, ["query"]) },
  kind: "search",
  title: (args) => `Search ${args.query ?? ""}`,
  async run(args, context) {
    if (!context.filesystem.search) throw new Error("Search is unavailable in this workspace");
    const result = await context.filesystem.search({ query: string(args, "query", false), regex: args.regex === true,
      caseSensitive: args.case_sensitive === true, include: typeof args.include === "string" ? args.include : undefined }, context.signal);
    const matches = result.matches.slice(0, 200).map((match) => `${match.path}:${match.line}: ${match.text.trim().slice(0, 300)}`);
    return matches.join("\n") + (result.truncated || result.matches.length > 200 ? "\n[More matches; narrow the search]" : "") || "No matches";
  },
};
export const readFile: AgentTool = {
  spec: { name: "read_file", description: "Read a text file, including unsaved editor changes.",
    parameters: object({ path, line: { type: "integer", description: "First line, 1-based" }, limit: { type: "integer", description: "Number of lines" } }, ["path"]) },
  kind: "read",
  title: (args) => `Read ${args.path ?? ""}`,
  async run(args, context) {
    const { absolute } = file(context, args);
    const result = await context.request("fs/read_text_file", { sessionId: context.sessionId, toolCallId: context.toolCallId, path: absolute,
      line: lineArg(args, "line"), limit: lineArg(args, "limit") });
    return clip(result.content);
  },
};
export const writeFile: AgentTool = {
  spec: { name: "write_file", description: "Create or replace a whole file. The user reviews the change before it is saved.",
    parameters: object({ path, content: { type: "string" } }, ["path", "content"]) },
  kind: "edit",
  mutates: true,
  title: (args) => `Write ${args.path ?? ""}`,
  async run(args, context) {
    const { absolute } = file(context, args);
    const content = string(args, "content");
    const before = await read(context, absolute).catch(() => null);
    return write(context, args, absolute, before, content);
  },
};
export const editFile: AgentTool = {
  spec: { name: "edit_file", description: "Replace an exact string in a file. old_string must match once unless replace_all is true. The user reviews the change before it is saved.",
    parameters: object({ path, old_string: { type: "string" }, new_string: { type: "string" }, replace_all: { type: "boolean" } }, ["path", "old_string", "new_string"]) },
  kind: "edit",
  mutates: true,
  title: (args) => `Edit ${args.path ?? ""}`,
  async run(args, context) {
    const { absolute } = file(context, args);
    const find = string(args, "old_string", false);
    const replacement = string(args, "new_string");
    const before = await read(context, absolute);
    const found = occurrences(before, find);
    if (!found) throw new Error(`old_string was not found in ${args.path}. Read the file and copy the text exactly.`);
    if (found > 1 && args.replace_all !== true)
      throw new Error(`old_string matches ${found} times in ${args.path}. Add surrounding lines or set replace_all.`);
    return write(context, args, absolute, before, args.replace_all === true ? before.split(find).join(replacement) : before.replace(find, () => replacement));
  },
};
export const diagnostics: AgentTool = {
  spec: { name: "diagnostics", description: "Language diagnostics for a file, or for the open files when path is omitted.", parameters: object({ path }) },
  kind: "read",
  title: (args) => `Diagnostics ${args.path ?? ""}`.trim(),
  async run(args, context) {
    const relative = args.path === undefined ? undefined : file(context, args).relative;
    const result = await context.request("oxbit/diagnostics", { sessionId: context.sessionId, toolCallId: context.toolCallId, ...(relative ? { path: relative } : {}) });
    const lines = (result?.diagnostics ?? []).map((item: Params) =>
      `${item.path}:${item.line}:${item.character} ${item.source ? `[${item.source}] ` : ""}${item.message}`);
    return lines.join("\n") || "No diagnostics";
  },
};
export const updatePlan: AgentTool = {
  spec: { name: "update_plan", description: "Show the user a plan for multi-step work. Send the full list each time.",
    parameters: object({ entries: { type: "array", items: object({ content: { type: "string" },
      status: { type: "string", enum: ["pending", "in_progress", "completed"] }, priority: { type: "string", enum: ["high", "medium", "low"] } }, ["content", "status"]) } }, ["entries"]) },
  kind: "think",
  title: () => "Update plan",
  async run(args, context) {
    if (!Array.isArray(args.entries) || args.entries.length > 50) throw new Error("Provide up to 50 plan entries");
    const entries = args.entries.map((entry: Params) => {
      if (!["pending", "in_progress", "completed"].includes(entry?.status)) throw new Error("Use pending, in_progress or completed");
      return { content: string(entry, "content", false).slice(0, 2000), status: entry.status, priority: ["high", "medium", "low"].includes(entry.priority) ? entry.priority : "medium" };
    });
    context.update({ sessionUpdate: "plan", entries });
    return "Plan updated";
  },
};

const terminalText = (result: Params | undefined, status: string) =>
  [(result?.output ?? "").replace(/\s+$/, ""), result?.truncated ? "[Output truncated to the last bytes]" : "", `[${status}]`].filter(Boolean).join("\n");

/** Runs `bash -c` through ACP terminal/* requests and returns the output with the exit status. */
export const bash: AgentTool = {
  spec: { name: "bash", description: "Run a shell command with bash -c in the workspace. Returns stdout and stderr together, then the exit code.",
    parameters: object({ command: { type: "string" }, cwd: { ...path, description: "Directory relative to the workspace root; omit for the root" },
      timeout_ms: { type: "integer", description: `Default ${BASH_TIMEOUT}, at most ${BASH_MAX_TIMEOUT}` } }, ["command"]) },
  kind: "execute",
  mutates: true,
  title: (args) => typeof args.command === "string" ? args.command.split("\n")[0] : "bash",
  async run(args, context) {
    const { sessionId, toolCallId, signal } = context;
    const command = string(args, "command", false);
    const timeout = args.timeout_ms === undefined ? BASH_TIMEOUT : lineArg(args, "timeout_ms")!;
    if (timeout > BASH_MAX_TIMEOUT) throw new Error(`timeout_ms must be at most ${BASH_MAX_TIMEOUT}`);
    const cwd = resolvePath(context.root, args.cwd).absolute;
    if (signal.aborted) throw new Error("Cancelled by the user");
    const { terminalId } = await context.request("terminal/create",
      { sessionId, command: "bash", args: ["-c", command], cwd, outputByteLimit: OUTPUT_LIMIT });
    const terminal = { sessionId, terminalId };
    context.update({ sessionUpdate: "tool_call_update", toolCallId, content: [{ type: "terminal", terminalId }] });
    let stopped: string | undefined;
    let interrupt: (reason: string) => void = () => {};
    const interrupted = new Promise<never>((_, reject) => {
      interrupt = (reason) => {
        stopped ??= reason;
        void context.request("terminal/kill", terminal).catch(() => {});
        reject(new Error(reason));
      };
    });
    interrupted.catch(() => {});
    const cancel = () => interrupt("Cancelled by the user");
    signal.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => interrupt(`Timed out after ${timeout} ms`), timeout);
    try {
      const exit = await Promise.race([context.request("terminal/wait_for_exit", terminal), interrupted]);
      const result = await context.request("terminal/output", terminal);
      const status = exit?.signal ? `Killed by ${exit.signal}` : `Exit code ${exit?.exitCode ?? "unknown"}`;
      const text = terminalText(result, status);
      if (exit?.exitCode !== 0) throw new Error(text);
      return text;
    } catch (error) {
      if (!stopped) throw error;
      throw new Error(terminalText(await context.request("terminal/output", terminal).catch(() => undefined), stopped));
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      await context.request("terminal/release", terminal).catch(() => {});
    }
  },
};

export const TOOLS: AgentTool[] = [listFiles, search, readFile, writeFile, editFile, diagnostics, updatePlan];
export const builtinTools = (capabilities: HostCapabilities) => [
  ...TOOLS.filter((tool) => tool !== diagnostics || capabilities.diagnostics !== false),
  ...capabilities.terminal ? [bash] : [],
];

export interface ToolGate {
  /** Returns the arguments to run with. Throwing fails the call with the error message. */
  before?(tool: AgentTool, args: Params, toolCallId: string): Promise<Params>;
  /** Text appended to the output the model sees. */
  after?(tool: AgentTool, args: Params, toolCallId: string, output: string, failed: boolean): Promise<string | undefined>;
}

const parseArguments = (text: string): Params | string => {
  try {
    const parsed = JSON.parse(text || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : "Tool arguments must be a JSON object";
  } catch {
    return "Tool arguments are not valid JSON";
  }
};
const locations = (root: string, args: Params) => {
  try {
    if (typeof args.path !== "string" || !args.path) return undefined;
    const line = Number.isSafeInteger(args.line) && args.line > 0 ? args.line - 1 : undefined;
    return [{ path: resolvePath(root, args.path).absolute, ...(line === undefined ? {} : { line }) }];
  } catch {
    return undefined;
  }
};

type RunContext = Omit<ToolContext, "toolCallId">;
const failed = (call: ToolCall, output: string): ToolResult => ({ id: call.id, name: call.name, output, error: true });

/** Runs one tool call from `tools` and reports it as ACP tool_call and tool_call_update notifications. */
export async function runTool(call: ToolCall, context: RunContext, tools: readonly AgentTool[] = TOOLS, gate: ToolGate = {}): Promise<ToolResult> {
  const parsed = parseArguments(call.arguments);
  let args = typeof parsed === "string" ? {} : parsed;
  const tool = tools.find((item) => item.spec.name === call.name);
  const toolCallId = call.id;
  const update = (status: "completed" | "failed", output: string) =>
    context.update({ sessionUpdate: "tool_call_update", toolCallId, status, rawOutput: output.slice(0, 8000) });
  const where = locations(context.root, args);
  context.update({ sessionUpdate: "tool_call", toolCallId, title: (tool?.title(args) ?? call.name).slice(0, 200), kind: tool?.kind ?? "other",
    status: "in_progress", rawInput: args, ...(where ? { locations: where } : {}) });
  try {
    if (typeof parsed === "string") throw new Error(parsed);
    if (!tool) throw new Error(`Unknown tool ${call.name}`);
    if (gate.before) {
      const next = await gate.before(tool, args, toolCallId);
      if (next !== args) context.update({ sessionUpdate: "tool_call_update", toolCallId, title: tool.title(next).slice(0, 200), rawInput: next });
      args = next;
    }
  } catch (error) {
    const output = error instanceof Error ? error.message : String(error);
    update("failed", output);
    return failed(call, output);
  }
  let output: string;
  let error = false;
  try {
    output = await tool.run(args, { ...context, toolCallId });
  } catch (thrown) {
    output = thrown instanceof Error ? thrown.message : String(thrown);
    error = true;
  }
  try {
    const extra = await gate.after?.(tool, args, toolCallId, output, error);
    if (extra) output += `\n\n${extra}`;
  } catch (thrown) {
    update("failed", output);
    throw thrown;
  }
  update(error ? "failed" : "completed", output);
  return error ? failed(call, output) : { id: call.id, name: call.name, output };
}
