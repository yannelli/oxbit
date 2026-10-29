import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const MARKER = 'tools/agent-memory/bin/hook.mjs';
export const TOOLS = ['claude', 'codex', 'cursor'];

function command(hookPath, tool, project) {
  const scope = project ? ` --project "${project}"` : '';
  return `node "${hookPath}" --tool ${tool}${scope}`;
}

/** Hook events per tool. Cursor has no prompt or post-compaction context event, so it gets tool output only. */
export function plan(tool, { repo, hookPath, home = homedir() }) {
  if (tool === 'claude') {
    const entry = (matcher) => ({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: command(hookPath, 'claude'), timeout: 5 }] });
    return {
      file: join(repo, '.claude', 'settings.local.json'),
      events: { UserPromptSubmit: entry(), PostToolUse: entry('Bash'), SessionStart: entry('compact|clear'), PreCompact: entry() },
    };
  }
  if (tool === 'codex') {
    const entry = () => ({ hooks: [{ type: 'command', command: command(hookPath, 'codex', repo), timeout: 5 }] });
    return {
      file: join(home, '.codex', 'hooks.json'),
      events: { UserPromptSubmit: entry(), PostToolUse: entry(), SessionStart: entry(), PreCompact: entry() },
    };
  }
  const entry = () => ({ command: command(hookPath, 'cursor', repo), timeout: 5 });
  return {
    file: join(home, '.cursor', 'hooks.json'),
    base: { version: 1 },
    events: { postToolUse: entry(), preCompact: entry() },
  };
}

function readJson(file) {
  if (!existsSync(file)) return {};
  return JSON.parse(readFileSync(file, 'utf8'));
}

function isOurs(entry) {
  return JSON.stringify(entry).includes(MARKER);
}

function withoutOurs(hooks) {
  const out = {};
  for (const [event, entries] of Object.entries(hooks ?? {})) {
    const kept = Array.isArray(entries) ? entries.filter((entry) => !isOurs(entry)) : entries;
    if (!Array.isArray(kept) || kept.length > 0) out[event] = kept;
  }
  return out;
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Adds the hook entries, replacing earlier ones from this script and keeping every other hook. */
export function enable(tool, options) {
  const { file, events, base = {} } = plan(tool, options);
  const current = readJson(file);
  const hooks = withoutOurs(current.hooks);
  for (const [event, entry] of Object.entries(events)) hooks[event] = [...(hooks[event] ?? []), entry];
  const next = { ...base, ...current, hooks };
  if (!options.dryRun) writeJson(file, next);
  return { file, events: Object.keys(events) };
}

/** Removes this script's entries; deletes the file when nothing else is left in it. */
export function disable(tool, options) {
  const { file, base = {} } = plan(tool, options);
  if (!existsSync(file)) return { file, removed: false };
  const current = readJson(file);
  const hooks = withoutOurs(current.hooks);
  const next = { ...current, hooks };
  if (Object.keys(hooks).length === 0) delete next.hooks;
  const leftover = Object.keys(next).filter((key) => !(key in base) || next[key] !== base[key]);
  if (options.dryRun) return { file, removed: true };
  if (leftover.length === 0) rmSync(file, { force: true });
  else writeJson(file, next);
  return { file, removed: true, deleted: leftover.length === 0 };
}
