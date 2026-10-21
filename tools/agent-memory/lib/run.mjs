import { appendFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { cacheDir } from './config.mjs';
import { hookOutput, formatLine, renderContext } from './format.mjs';
import { loadIndex } from './index-cache.mjs';
import { searchIndex } from './lexical.mjs';
import { carryOver, loadSession, markCompaction, pruneSessions, recordShown, saveSession, selectHits, sessionKey } from './session.mjs';

const PROMPT_EVENTS = new Set(['UserPromptSubmit']);
const TOOL_EVENTS = new Set(['PostToolUse', 'postToolUse']);
const COMPACT_EVENTS = new Set(['PreCompact', 'PostCompact', 'preCompact']);
const INPUT_KEYS = ['command', 'cmd', 'file_path', 'path', 'pattern', 'query', 'url', 'description'];

export function findRepo(start) {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function headTail(text, max) {
  const value = String(text ?? '');
  return value.length <= max ? value : `${value.slice(0, max / 2)}\n${value.slice(-max / 2)}`;
}

function outputText(value, max) {
  if (value == null) return '';
  if (typeof value === 'string') return headTail(value, max);
  if (typeof value.stdout === 'string' || typeof value.stderr === 'string') {
    return `${headTail(value.stderr, max / 2)}\n${headTail(value.stdout, max / 2)}`;
  }
  return headTail(JSON.stringify(value), max);
}

/** Query text for a tool call: the command or path, then the head and tail of its output. */
export function toolQuery(input, config) {
  const toolInput = typeof input.tool_input === 'string' ? { command: input.tool_input } : (input.tool_input ?? {});
  const parts = INPUT_KEYS.map((key) => toolInput[key]).filter((value) => typeof value === 'string');
  const output = input.tool_response ?? input.tool_output ?? input.output;
  return `${parts.join('\n')}\n${outputText(output, config.match.toolOutputChars)}`;
}

/** Sorts the event into prompt, tool, compact, start (with its source), or skip. */
export function classify(event, input, config) {
  if (PROMPT_EVENTS.has(event)) return { kind: 'prompt', query: String(input.prompt ?? '') };
  if (TOOL_EVENTS.has(event)) {
    if (!new RegExp(config.match.toolPattern).test(String(input.tool_name ?? ''))) return { kind: 'skip' };
    return { kind: 'tool', query: toolQuery(input, config) };
  }
  if (COMPACT_EVENTS.has(event)) return { kind: 'compact' };
  if (event === 'SessionStart' || event === 'sessionStart') return { kind: 'start', source: input.source ?? 'startup' };
  return { kind: 'skip' };
}

function transcriptSize(path) {
  try {
    return path ? statSync(path).size : null;
  } catch {
    return null;
  }
}

function insideProject(cwd, project) {
  const root = resolve(project);
  const here = resolve(cwd);
  return here === root || here.startsWith(root + sep);
}

async function semanticHits(query, index, config, dir, env) {
  const { pickBackend } = await import('./resources.mjs');
  const { semanticSearch } = await import('./embed.mjs');
  const choice = await pickBackend(config, { cacheFile: join(dir, 'resources.json'), env });
  if (!choice.ok) return { backend: 'lexical', reason: choice.reasons.join(', '), hits: [] };
  const result = await semanticSearch(query, choice, config, { dir });
  if (!result.used) return { backend: 'lexical', reason: result.reason, hits: [] };
  const byId = new Map(index.docs.map((doc) => [doc.id, doc]));
  const hits = result.hits
    .filter((hit) => hit.score >= config.embedding.minScore && byId.has(hit.id))
    .map((hit) => ({ ...byId.get(hit.id), semantic: hit.score }));
  return { backend: choice.backend, reason: 'ok', hits };
}

async function rankedHits(query, index, config, dir, env) {
  const { maxQueryTerms, minScore, minTerms, strongScore, minRelative } = config.match;
  const found = searchIndex(index, query, { maxTerms: maxQueryTerms, minScore, minTerms: Math.min(2, minTerms), limit: 10 })
    .filter((hit) => hit.matched.length >= minTerms || hit.score >= strongScore);
  const lexical = found.filter((hit) => hit.score >= found[0].score * minRelative);
  if (!config.embedding.enabled) return { backend: 'lexical', reason: 'embedding disabled', hits: lexical };
  const semantic = await semanticHits(query, index, config, dir, env);
  if (semantic.hits.length === 0) return { ...semantic, hits: lexical };
  const { fuseRrf } = await import('./embed.mjs');
  const merged = new Map([...semantic.hits, ...lexical].map((hit) => [hit.id, hit]));
  for (const hit of semantic.hits) merged.set(hit.id, { ...merged.get(hit.id), semantic: hit.semantic });
  const fused = fuseRrf([lexical, semantic.hits]).map(({ id }) => merged.get(id));
  return { ...semantic, hits: fused };
}

/** Runs one hook call and returns the stdout text plus a log record. */
export async function runHook({ tool, event, input, config, env = process.env, now = Date.now(), project, onStale }) {
  const started = performance.now();
  const cwd = input.cwd ?? input.workspace_roots?.[0] ?? process.cwd();
  if (project && !insideProject(cwd, project)) return { stdout: '', log: null };
  const action = classify(event, input, config);
  if (action.kind === 'skip') return { stdout: '', log: null };

  const dir = cacheDir(config, env);
  mkdirSync(dir, { recursive: true });
  const key = sessionKey(tool, input);
  const state = loadSession(dir, key, now);
  if (state.calls === 0 && state.epoch === 0) pruneSessions(dir, now);
  state.calls += 1;
  const transcriptBytes = transcriptSize(input.transcript_path);
  const log = { at: new Date(now).toISOString(), tool, event, key, kind: action.kind, shown: [] };
  let context = '';

  if (action.kind === 'compact' || (action.kind === 'start' && ['compact', 'clear'].includes(action.source))) {
    log.newEpoch = markCompaction(state, now);
  }
  if (action.kind === 'start' && action.source === 'compact') {
    const picked = carryOver(state, config.resurface.onCompactLines).map((hit) => ({ ...hit, reason: 'shown before compaction', text: formatLine(hit) }));
    recordShown(state, picked, { now, transcriptBytes });
    context = renderContext(picked, { carryOver: true });
    log.shown = picked.map((hit) => hit.id);
  }
  if (action.kind === 'prompt' || action.kind === 'tool') {
    const repo = findRepo(cwd);
    const { index, stale } = loadIndex(config, { repo, env, allowStale: true });
    if (stale) onStale?.(repo);
    const ranked = await rankedHits(action.query, index, config, dir, env);
    const picked = selectHits(state, ranked.hits, { now, transcriptBytes, budget: config.budget, resurface: config.resurface, format: formatLine });
    recordShown(state, picked, { now, transcriptBytes });
    context = renderContext(picked);
    Object.assign(log, { backend: ranked.backend, backendReason: ranked.reason, stale, candidates: ranked.hits.length });
    log.shown = picked.map((hit) => `${hit.id} (${hit.reason})`);
  }
  saveSession(dir, state);
  log.ms = Number((performance.now() - started).toFixed(1));
  log.chars = context.length;
  return { stdout: hookOutput(tool, event, context), log, dir };
}

export function appendLog(dir, log) {
  if (!dir || !log) return;
  try {
    appendFileSync(join(dir, 'hook.log.jsonl'), `${JSON.stringify(log)}\n`);
  } catch {
    // logging is best effort
  }
}
