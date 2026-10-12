import type { HookEvent, HookOutcome, HookRunner, Params } from "./extensions.js";

/** `claude` and `codex` sources get Claude tool names in `tool_name`; `oxbit` sources get Oxbit names. */
export type HookDialect = "oxbit" | "claude" | "codex";
/** One settings.json or hooks.json that the host read and parsed. */
export interface HookSource { dialect: HookDialect; path: string; config: unknown }
export interface HookExecOptions {
  stdin: string;
  cwd: string;
  /** Added to the host's own environment. */
  env: Record<string, string>;
  timeoutMs: number;
  /** Aborts on cancel and on timeout; the host kills the process. */
  signal: AbortSignal;
}
/** `code` is null when the process was killed. */
export interface HookExecResult { code: number | null; stdout: string; stderr: string }
/** Runs `command` in a shell (`/bin/sh -c` on unix) with `stdin` written and closed. */
export type HookExec = (command: string, options: HookExecOptions) => Promise<HookExecResult>;
export interface HookRunnerOptions {
  /** Called on every event when a function, so the host can read project files for the session cwd. */
  sources: HookSource[] | ((cwd: string) => HookSource[] | Promise<HookSource[]>);
  exec: HookExec;
  transcriptPath?(sessionId: string): string;
  onWarning?(message: string): void;
  /** Called on every event; true leaves the hook out. */
  skip?(hook: HookEntry): boolean;
}
/** One command hook from a source. `id` is `dialect|path|event|matcher|command`. */
export interface HookEntry { id: string; dialect: HookDialect; path: string; event: string; matcher: string; command: string }
export interface CommandHookRunner extends HookRunner { readonly warnings: readonly string[] }

/** Claude Code names that hook matchers and `if` rules accept for Oxbit tools. The first name goes in `tool_name`. */
export const CLAUDE_TOOL_NAMES: Readonly<Record<string, readonly string[]>> = {
  read_file: ["Read"], write_file: ["Write"], edit_file: ["Edit"], bash: ["Bash"], search: ["Grep"], list_files: ["LS", "Glob"],
  update_plan: ["TodoWrite"],
};
const EVENTS = new Set<string>(["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop", "PreCompact",
  "PostCompact", "SessionEnd"]);
const TOOL_EVENTS = new Set<string>(["PreToolUse", "PostToolUse", "PostToolUseFailure"]);
const BLOCKING = new Set<string>([...TOOL_EVENTS, "UserPromptSubmit", "Stop", "PreCompact"]);
const PLAIN_CONTEXT = new Set<string>(["UserPromptSubmit", "SessionStart"]);
const MATCH_FIELD: Partial<Record<HookEvent, string>> = { SessionStart: "source", PreCompact: "trigger", PostCompact: "trigger", SessionEnd: "reason" };
const CONTEXT_LIMIT = 10000;
const WARNING_LIMIT = 100;

/** Settings files in load order. Claude and Codex files are opt-in. */
export function hookSourcePaths(home: string, project: string, options: { claude?: boolean; codex?: boolean } = {}) {
  const paths: { dialect: HookDialect; path: string }[] = [
    { dialect: "oxbit", path: `${home}/.oxbit/agent/settings.json` }, { dialect: "oxbit", path: `${project}/.oxbit/settings.json` }];
  if (options.claude) paths.push({ dialect: "claude", path: `${home}/.claude/settings.json` }, { dialect: "claude", path: `${project}/.claude/settings.json` },
    { dialect: "claude", path: `${project}/.claude/settings.local.json` });
  if (options.codex) paths.push({ dialect: "codex", path: `${home}/.codex/hooks.json` }, { dialect: "codex", path: `${project}/.codex/hooks.json` });
  return paths;
}

interface Handler extends HookEntry {
  timeoutMs: number;
  rule?: string;
  async: boolean;
  failBlocks: boolean;
}
const isObject = (value: unknown): value is Params => typeof value === "object" && value !== null && !Array.isArray(value);
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

function parse(source: HookSource, warn: (message: string) => void): Handler[] {
  const hooks = isObject(source.config) ? source.config.hooks : undefined;
  if (hooks === undefined) return [];
  if (!isObject(hooks)) {
    warn(`${source.path}: "hooks" must be an object`);
    return [];
  }
  const handlers: Handler[] = [];
  for (const [event, groups] of Object.entries(hooks)) {
    if (!EVENTS.has(event) || !Array.isArray(groups)) continue;
    for (const group of groups) {
      for (const entry of isObject(group) && Array.isArray(group.hooks) ? group.hooks : []) {
        if (!isObject(entry) || entry.type !== "command" || typeof entry.command !== "string" || !entry.command) {
          warn(`${source.path}: skipped a ${isObject(entry) ? entry.type ?? "untyped" : "malformed"} ${event} hook; Oxbit runs command hooks only`);
          continue;
        }
        const args = Array.isArray(entry.args) ? entry.args.filter((arg: unknown) => typeof arg === "string") : undefined;
        const seconds = typeof entry.timeout === "number" && entry.timeout > 0 ? entry.timeout : event === "UserPromptSubmit" ? 30 : 600;
        const matcher = typeof group.matcher === "string" ? group.matcher : "";
        const command = args ? [entry.command, ...args].map(quote).join(" ") : entry.command;
        handlers.push({ id: [source.dialect, source.path, event, matcher, command].join("|"), dialect: source.dialect, path: source.path, event, matcher,
          command, timeoutMs: seconds * 1000, rule: typeof entry.if === "string" ? entry.if : undefined, async: entry.async === true,
          failBlocks: entry.onFailure === "block" });
      }
    }
  }
  return handlers;
}

/** The command hooks of `sources` in load order, and the warnings from parsing them. */
export function listHooks(sources: HookSource[]): { hooks: HookEntry[]; warnings: string[] } {
  const warnings: string[] = [];
  const hooks = sources.flatMap((source) => parse(source, (message) => warnings.push(message)))
    .map(({ id, dialect, path, event, matcher, command }) => ({ id, dialect, path, event, matcher, command }));
  return { hooks, warnings };
}

/** `*`, empty: all. Letters, digits, `_`, `-`, space, `,` and `|` only: exact names. Anything else: unanchored regex. */
export function matchesHook(matcher: string, values: readonly string[]) {
  if (!matcher || matcher === "*") return true;
  if (/^[\w\- ,|]+$/.test(matcher)) return matcher.split(/[|,]/).map((name) => name.trim()).some((name) => values.includes(name));
  try {
    const pattern = new RegExp(matcher);
    return values.some((value) => pattern.test(value));
  } catch {
    return false;
  }
}

const glob = (pattern: string, star: string) =>
  new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(star).replace(/(\[\^\/\]\*){2}/g, ".*")}$`);
/** A Claude permission rule such as `Bash(git *)` or `Edit(*.ts)`. Runs the hook when the input cannot be checked. */
function ruleAllows(rule: string, names: readonly string[], input: Params) {
  const match = /^\s*([\w-]+)\s*(?:\(([\s\S]*)\))?\s*$/.exec(rule);
  if (!match) return true;
  if (!names.includes(match[1])) return false;
  const pattern = match[2]?.trim();
  if (!pattern || pattern === "*") return true;
  if (typeof input.command === "string") {
    if (/\$\(|`/.test(input.command)) return true;
    const test = glob(pattern, ".*");
    return input.command.split(/&&|\|\||[;|\n]/).map((part) => part.trim().replace(/^(?:\w+=\S*\s+)*/, "")).some((part) => test.test(part));
  }
  const path = typeof input.path === "string" ? input.path : typeof input.file_path === "string" ? input.file_path : undefined;
  if (path === undefined) return true;
  const test = glob(pattern.replace(/^\.?\//, ""), "[^/]*");
  return test.test(path.replace(/^\.?\//, "")) || (!pattern.includes("/") && test.test(path.split("/").pop()!));
}

function fromJson(event: HookEvent, json: Params): HookOutcome {
  const outcome: HookOutcome = {};
  const specific = isObject(json.hookSpecificOutput) ? json.hookSpecificOutput : {};
  if (json.continue === false) outcome.continue = false;
  if (typeof json.stopReason === "string") outcome.stopReason = json.stopReason;
  if (typeof json.systemMessage === "string") outcome.systemMessage = json.systemMessage;
  if (event === "PreToolUse") {
    const legacy = json.decision === "approve" ? "allow" : json.decision === "block" ? "deny" : undefined;
    const decision = specific.permissionDecision ?? legacy;
    if (["allow", "deny", "ask", "defer"].includes(decision)) outcome.permission = decision === "defer" ? "ask" : decision;
    const reason = specific.permissionDecisionReason ?? json.reason;
    if (outcome.permission && typeof reason === "string") outcome.permissionReason = reason;
  } else if (json.decision === "block") {
    outcome.block = true;
    if (typeof json.reason === "string") outcome.reason = json.reason;
  }
  if (isObject(specific.updatedInput)) outcome.updatedInput = specific.updatedInput;
  if (typeof specific.additionalContext === "string") outcome.additionalContext = specific.additionalContext;
  return outcome;
}

const RANK = { allow: 1, ask: 2, deny: 3 } as const;
/** Any block or continue: false wins; permission deny > ask > allow; the last updatedInput wins; text fields join. */
export function mergeOutcomes(event: HookEvent, outcomes: HookOutcome[]): HookOutcome {
  const merged: HookOutcome = {};
  const joined = (values: (string | undefined)[], separator: string) => values.filter((value) => !!value).join(separator) || undefined;
  const halted = outcomes.filter((outcome) => outcome.continue === false);
  if (halted.length) Object.assign(merged, { continue: false, stopReason: joined(halted.map((outcome) => outcome.stopReason), "\n") });
  const blocks = outcomes.filter((outcome) => outcome.block);
  if (blocks.length) Object.assign(merged, { block: true, reason: joined(blocks.map((outcome) => outcome.reason), "\n") });
  const permission = outcomes.reduce<HookOutcome["permission"]>((best, outcome) =>
    outcome.permission && (!best || RANK[outcome.permission] > RANK[best]) ? outcome.permission : best, undefined);
  if (event === "PreToolUse" && blocks.length) Object.assign(merged, { permission: "deny", permissionReason: merged.reason });
  else if (permission) Object.assign(merged, { permission,
    permissionReason: joined(outcomes.filter((outcome) => outcome.permission === permission).map((outcome) => outcome.permissionReason), "\n") });
  const updated = outcomes.filter((outcome) => outcome.updatedInput).at(-1)?.updatedInput;
  if (updated) merged.updatedInput = updated;
  const context = joined(outcomes.map((outcome) => outcome.additionalContext), "\n\n");
  if (context) merged.additionalContext = context.slice(0, CONTEXT_LIMIT);
  const message = joined(outcomes.map((outcome) => outcome.systemMessage), "\n");
  if (message) merged.systemMessage = message;
  for (const key of Object.keys(merged) as (keyof HookOutcome)[]) if (merged[key] === undefined) delete merged[key];
  return merged;
}

/** Runs command hooks from Claude Code settings files and Codex hooks.json files. */
export function createHookRunner(options: HookRunnerOptions): CommandHookRunner {
  const warnings: string[] = [];
  const reported = new Set<string>();
  const cache = new WeakMap<object, Handler[]>();
  const warn = (message: string) => {
    warnings.push(message);
    if (warnings.length > WARNING_LIMIT) warnings.shift();
    options.onWarning?.(message);
  };
  const warnOnce = (message: string) => {
    if (reported.has(message)) return;
    reported.add(message);
    warn(message);
  };
  const handlersOf = (source: HookSource) => {
    if (!isObject(source.config)) return parse(source, warnOnce);
    let handlers = cache.get(source.config);
    if (!handlers) cache.set(source.config, handlers = parse(source, warnOnce));
    return handlers;
  };

  async function runOne(handler: Handler, event: HookEvent, input: Params, signal: AbortSignal): Promise<HookOutcome> {
    const name = typeof input.tool_name === "string" ? input.tool_name : undefined;
    const alias = name && handler.dialect !== "oxbit" ? CLAUDE_TOOL_NAMES[name]?.[0] : undefined;
    const stdin = { transcript_path: options.transcriptPath?.(String(input.session_id ?? "")) ?? "", ...input,
      ...name ? { tool_name: alias ?? name, oxbit_tool_name: name } : {} };
    const cwd = String(input.cwd ?? "");
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timer = setTimeout(abort, handler.timeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    const killed = new Promise<HookExecResult>((resolve) =>
      controller.signal.addEventListener("abort", () => resolve({ code: null, stdout: "", stderr: "" }), { once: true }));
    const label = `${handler.path}: ${event} hook "${handler.command}"`;
    const failed = (detail: string): HookOutcome => {
      warn(`${label} ${detail}`);
      return handler.failBlocks && BLOCKING.has(event) && !signal.aborted ? { block: true, reason: `${label} ${detail}` } : {};
    };
    try {
      const result = await Promise.race([options.exec(handler.command, { stdin: JSON.stringify(stdin), cwd,
        env: { CLAUDE_PROJECT_DIR: cwd, OXBIT_PROJECT_DIR: cwd }, timeoutMs: handler.timeoutMs, signal: controller.signal }), killed]);
      if (result.code === null) return signal.aborted ? {} : failed(`timed out after ${handler.timeoutMs / 1000} s`);
      if (result.code === 2) {
        const reason = result.stderr.trim() || `Blocked by ${handler.command}`;
        if (BLOCKING.has(event)) return { block: true, reason };
        warn(`${label} exited with 2: ${reason}`);
        return {};
      }
      if (result.code !== 0) return failed(`exited with ${result.code}${result.stderr.trim() ? `: ${result.stderr.trim()}` : ""}`);
      const stdout = result.stdout.trim();
      if (stdout.startsWith("{")) {
        try {
          const json = JSON.parse(stdout);
          if (isObject(json)) return fromJson(event, json);
        } catch {
          // Plain text that starts with a brace.
        }
      }
      return stdout && PLAIN_CONTEXT.has(event) ? { additionalContext: stdout } : {};
    } catch (error) {
      return failed(`failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }

  return {
    get warnings() {
      return warnings;
    },
    async run(event, input, signal) {
      if (signal.aborted) return {};
      const sources = typeof options.sources === "function" ? await options.sources(String(input.cwd ?? "")) : options.sources;
      if (sources.some((source) => isObject(source.config) && source.config.disableAllHooks === true)) return {};
      const tool = TOOL_EVENTS.has(event) && typeof input.tool_name === "string" ? input.tool_name : undefined;
      const names = tool ? [tool, ...CLAUDE_TOOL_NAMES[tool] ?? []] : undefined;
      const field = MATCH_FIELD[event];
      const values = names ?? (field && typeof input[field] === "string" ? [input[field] as string] : undefined);
      const selected = new Map<string, Handler>();
      for (const handler of sources.flatMap(handlersOf)) {
        if (handler.event !== event || (values && !matchesHook(handler.matcher, values)) || options.skip?.(handler)) continue;
        if (handler.rule !== undefined && !(names && ruleAllows(handler.rule, names, isObject(input.tool_input) ? input.tool_input : {}))) continue;
        const key = `${handler.command}\0${handler.rule ?? ""}`;
        if (!selected.has(key)) selected.set(key, handler);
      }
      const outcomes = await Promise.all([...selected.values()].map((handler) => {
        if (!handler.async) return runOne(handler, event, input, signal);
        void runOne(handler, event, input, signal);
        return {};
      }));
      return mergeOutcomes(event, outcomes);
    },
  };
}
