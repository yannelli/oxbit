import type { FileSystem } from "@oxbit/sdk";
import type { ToolCall, ToolResult, ToolSpec } from "./model.js";

type Params = Record<string, any>;
export interface ToolContext {
  root: string;
  sessionId: string;
  filesystem: FileSystem;
  signal: AbortSignal;
  /** An ACP client request the editor answers: fs/read_text_file, fs/write_text_file or oxbit/diagnostics. */
  request(method: string, params: Params): Promise<any>;
  update(update: Params): void;
}

const OUTPUT_LIMIT = 100000;
const path = { type: "string", description: "Path relative to the workspace root" };
const object = (properties: Params, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
export const TOOLS: ToolSpec[] = [
  { name: "list_files", description: "List one workspace directory. Directory names end with /.",
    parameters: object({ path: { ...path, description: "Directory relative to the workspace root; omit for the root" } }) },
  { name: "search", description: "Search file contents in the workspace. Returns path:line: text matches.",
    parameters: object({ query: { type: "string" }, regex: { type: "boolean" }, case_sensitive: { type: "boolean" },
      include: { type: "string", description: "Comma-separated globs, for example src/**/*.ts" } }, ["query"]) },
  { name: "read_file", description: "Read a text file, including unsaved editor changes.",
    parameters: object({ path, line: { type: "integer", description: "First line, 1-based" }, limit: { type: "integer", description: "Number of lines" } }, ["path"]) },
  { name: "write_file", description: "Create or replace a whole file. The user reviews the change before it is saved.",
    parameters: object({ path, content: { type: "string" } }, ["path", "content"]) },
  { name: "edit_file", description: "Replace an exact string in a file. old_string must match once unless replace_all is true. The user reviews the change before it is saved.",
    parameters: object({ path, old_string: { type: "string" }, new_string: { type: "string" }, replace_all: { type: "boolean" } }, ["path", "old_string", "new_string"]) },
  { name: "diagnostics", description: "Language diagnostics for a file, or for the open files when path is omitted.",
    parameters: object({ path }) },
  { name: "update_plan", description: "Show the user a plan for multi-step work. Send the full list each time.",
    parameters: object({ entries: { type: "array", items: object({ content: { type: "string" },
      status: { type: "string", enum: ["pending", "in_progress", "completed"] }, priority: { type: "string", enum: ["high", "medium", "low"] } }, ["content", "status"]) } }, ["entries"]) },
];

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

const TITLES: Record<string, [kind: string, title: (args: Params) => string]> = {
  list_files: ["read", (args) => `List ${args.path || "."}`],
  search: ["search", (args) => `Search ${args.query ?? ""}`],
  read_file: ["read", (args) => `Read ${args.path ?? ""}`],
  write_file: ["edit", (args) => `Write ${args.path ?? ""}`],
  edit_file: ["edit", (args) => `Edit ${args.path ?? ""}`],
  diagnostics: ["read", (args) => `Diagnostics ${args.path ?? ""}`.trim()],
  update_plan: ["think", () => "Update plan"],
};

async function execute(name: string, args: Params, context: ToolContext, toolCallId: string): Promise<string> {
  const { sessionId } = context;
  const file = () => {
    const resolved = resolvePath(context.root, string(args, "path", false));
    if (!resolved.relative) throw new Error("Choose a file inside the workspace");
    return resolved;
  };
  const read = async (absolute: string) => (await context.request("fs/read_text_file", { sessionId, toolCallId, path: absolute })).content as string;
  const write = async (absolute: string, oldText: string | null, newText: string) => {
    context.update({ sessionUpdate: "tool_call_update", toolCallId, content: [{ type: "diff", path: absolute, oldText, newText }] });
    await context.request("fs/write_text_file", { sessionId, toolCallId, path: absolute, content: newText });
    return `Saved ${args.path}`;
  };
  switch (name) {
    case "list_files": {
      const entries = await context.filesystem.list(resolvePath(context.root, args.path).relative);
      const names = entries.slice(0, 500).map((entry) => entry.path + (entry.kind === "directory" ? "/" : ""));
      return names.join("\n") + (entries.length > 500 ? `\n[${entries.length - 500} more entries]` : "") || "The directory is empty";
    }
    case "search": {
      if (!context.filesystem.search) throw new Error("Search is unavailable in this workspace");
      const result = await context.filesystem.search({ query: string(args, "query", false), regex: args.regex === true,
        caseSensitive: args.case_sensitive === true, include: typeof args.include === "string" ? args.include : undefined }, context.signal);
      const matches = result.matches.slice(0, 200).map((match) => `${match.path}:${match.line}: ${match.text.trim().slice(0, 300)}`);
      return matches.join("\n") + (result.truncated || result.matches.length > 200 ? "\n[More matches; narrow the search]" : "") || "No matches";
    }
    case "read_file": {
      const { absolute } = file();
      const result = await context.request("fs/read_text_file", { sessionId, toolCallId, path: absolute, line: lineArg(args, "line"), limit: lineArg(args, "limit") });
      return clip(result.content);
    }
    case "write_file": {
      const { absolute } = file();
      const content = string(args, "content");
      const before = await read(absolute).catch(() => null);
      return write(absolute, before, content);
    }
    case "edit_file": {
      const { absolute } = file();
      const find = string(args, "old_string", false);
      const replacement = string(args, "new_string");
      const before = await read(absolute);
      const found = occurrences(before, find);
      if (!found) throw new Error(`old_string was not found in ${args.path}. Read the file and copy the text exactly.`);
      if (found > 1 && args.replace_all !== true)
        throw new Error(`old_string matches ${found} times in ${args.path}. Add surrounding lines or set replace_all.`);
      return write(absolute, before, args.replace_all === true ? before.split(find).join(replacement) : before.replace(find, () => replacement));
    }
    case "diagnostics": {
      const relative = args.path === undefined ? undefined : file().relative;
      const result = await context.request("oxbit/diagnostics", { sessionId, toolCallId, ...(relative ? { path: relative } : {}) });
      const lines = (result?.diagnostics ?? []).map((item: Params) =>
        `${item.path}:${item.line}:${item.character} ${item.source ? `[${item.source}] ` : ""}${item.message}`);
      return lines.join("\n") || "No diagnostics";
    }
    case "update_plan": {
      if (!Array.isArray(args.entries) || args.entries.length > 50) throw new Error("Provide up to 50 plan entries");
      const entries = args.entries.map((entry: Params) => {
        if (!["pending", "in_progress", "completed"].includes(entry?.status)) throw new Error("Use pending, in_progress or completed");
        return { content: string(entry, "content", false).slice(0, 2000), status: entry.status, priority: ["high", "medium", "low"].includes(entry.priority) ? entry.priority : "medium" };
      });
      context.update({ sessionUpdate: "plan", entries });
      return "Plan updated";
    }
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}

/** Runs one tool call and reports it as ACP tool_call and tool_call_update notifications. */
export async function runTool(call: ToolCall, context: ToolContext): Promise<ToolResult> {
  let args: Params = {};
  let failure: string | undefined;
  try {
    const parsed = JSON.parse(call.arguments || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed;
    else failure = "Tool arguments must be a JSON object";
  } catch {
    failure = "Tool arguments are not valid JSON";
  }
  const [kind, title] = TITLES[call.name] ?? ["other", () => call.name];
  let locations: { path: string; line?: number }[] | undefined;
  try {
    if (typeof args.path === "string" && args.path) {
      const line = Number.isSafeInteger(args.line) && args.line > 0 ? args.line - 1 : undefined;
      locations = [{ path: resolvePath(context.root, args.path).absolute, ...(line === undefined ? {} : { line }) }];
    }
  } catch {
    locations = undefined;
  }
  context.update({ sessionUpdate: "tool_call", toolCallId: call.id, title: title(args).slice(0, 200), kind, status: "in_progress",
    rawInput: args, ...(locations ? { locations } : {}) });
  try {
    if (failure) throw new Error(failure);
    const output = await execute(call.name, args, context, call.id);
    context.update({ sessionUpdate: "tool_call_update", toolCallId: call.id, status: "completed", rawOutput: output.slice(0, 8000) });
    return { id: call.id, name: call.name, output };
  } catch (error) {
    const output = error instanceof Error ? error.message : String(error);
    context.update({ sessionUpdate: "tool_call_update", toolCallId: call.id, status: "failed", rawOutput: output.slice(0, 8000) });
    return { id: call.id, name: call.name, output, error: true };
  }
}
