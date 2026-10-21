import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from './index-cache.mjs';

const COMPACT_DEBOUNCE_MS = 5 * 60 * 1000;
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** One state per agent context: subagents get their own key, so they see memories their parent saw. */
export function sessionKey(tool, input) {
  const base = input.session_id ?? input.conversation_id ?? 'unknown';
  const agent = input.agent_id ?? input.subagent_id;
  return agent ? `${tool}:${base}:${agent}` : `${tool}:${base}`;
}

export function sessionPath(dir, key) {
  return join(dir, 'sessions', `${createHash('sha1').update(key).digest('hex').slice(0, 20)}.json`);
}

export function newSession(key, now) {
  return { key, createdAt: now, epoch: 0, calls: 0, epochChars: 0, compactedAt: 0, shown: {} };
}

export function loadSession(dir, key, now = Date.now()) {
  try {
    const state = JSON.parse(readFileSync(sessionPath(dir, key), 'utf8'));
    if (state.key === key) return state;
  } catch {
    // missing or unreadable state starts a new session
  }
  return newSession(key, now);
}

export function saveSession(dir, state) {
  const path = sessionPath(dir, state.key);
  mkdirSync(join(dir, 'sessions'), { recursive: true });
  writeJsonAtomic(path, state);
}

export function pruneSessions(dir, now = Date.now()) {
  const sessions = join(dir, 'sessions');
  let names = [];
  try {
    names = readdirSync(sessions);
  } catch {
    return;
  }
  for (const name of names) {
    try {
      if (now - statSync(join(sessions, name)).mtimeMs > SESSION_MAX_AGE_MS) rmSync(join(sessions, name), { force: true });
    } catch {
      // another hook process removed it first
    }
  }
}

/** Starts a new epoch: compaction drops earlier context, so every memory is eligible again. */
export function markCompaction(state, now = Date.now()) {
  if (now - state.compactedAt < COMPACT_DEBOUNCE_MS && state.epochChars === 0) return false;
  state.epoch += 1;
  state.epochChars = 0;
  state.compactedAt = now;
  return true;
}

/** Why a memory is eligible now, or null when it was shown recently in this context. */
export function resurfaceReason(state, id, { now, transcriptBytes, resurface }) {
  const seen = state.shown[id];
  if (!seen) return 'new';
  if (seen.epoch < state.epoch) return 'after compaction';
  if (now - seen.at >= resurface.afterMs) return 'time elapsed';
  if (transcriptBytes != null && seen.transcriptBytes != null) {
    if (transcriptBytes - seen.transcriptBytes >= resurface.transcriptGrowthBytes) return 'context grew';
  } else if (state.calls - seen.calls >= resurface.callsWithoutTranscript) {
    return 'context grew';
  }
  return null;
}

/** Picks eligible hits within the per-call and per-epoch character budgets. */
export function selectHits(state, hits, { now, transcriptBytes, budget, resurface, format }) {
  const picked = [];
  let chars = 0;
  for (const hit of hits) {
    if (picked.length >= budget.maxLines) break;
    const reason = resurfaceReason(state, hit.id, { now, transcriptBytes, resurface });
    if (state.shown[hit.id]) state.shown[hit.id].hits = (state.shown[hit.id].hits ?? 1) + 1;
    if (!reason) continue;
    const text = format({ ...hit, reason });
    if (chars + text.length > budget.maxChars) continue;
    if (state.epochChars + chars + text.length > budget.sessionMaxChars) break;
    chars += text.length + 1;
    picked.push({ ...hit, reason, text });
  }
  return picked;
}

export function recordShown(state, picked, { now, transcriptBytes }) {
  for (const hit of picked) {
    const hits = state.shown[hit.id]?.hits ?? 1;
    state.shown[hit.id] = { at: now, epoch: state.epoch, calls: state.calls, transcriptBytes, hits, path: hit.path, line: hit.line, title: hit.title, description: hit.description };
    state.epochChars += hit.text.length + 1;
  }
}

/** Memories shown before the latest compaction, most often matched first. */
export function carryOver(state, limit) {
  return Object.entries(state.shown)
    .filter(([, seen]) => seen.epoch < state.epoch)
    .sort((a, b) => (b[1].hits ?? 1) - (a[1].hits ?? 1) || b[1].at - a[1].at)
    .slice(0, limit)
    .map(([id, seen]) => ({ id, path: seen.path, line: seen.line, title: seen.title, description: seen.description, matched: [] }));
}
