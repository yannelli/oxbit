#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { loadavg, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, mergeConfig } from '../lib/config.mjs';

const PROMPTS = [
  'why does the release build fail after the dependency upgrade?',
  'git push fails with an authentication error',
  'add a settings toggle for the new editor option',
  'the terminal test is flaky on CI',
  'sign and notarize the desktop build',
  'upload the missing asset to the GitHub release',
  'run the lint and typecheck before opening the PR',
  'the language server crashes on large files',
  'write the TestFlight notes for the next version',
  'refactor the theme tokens in the preview CSS',
];

function percentile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

/** Times whole hook processes, node startup included, over `runs` prompts with a fresh session each. */
function bench(label, runs, env) {
  const hook = fileURLToPath(new URL('./hook.mjs', import.meta.url));
  const times = [];
  let shown = 0;
  for (let run = 0; run < runs; run += 1) {
    const input = JSON.stringify({ session_id: `bench-${label}-${Date.now()}-${run}`, cwd: process.cwd(), hook_event_name: 'UserPromptSubmit', prompt: PROMPTS[run % PROMPTS.length] });
    const started = performance.now();
    const result = spawnSync(process.execPath, [hook, '--tool', 'claude'], { input, env: { ...process.env, ...env } });
    times.push(performance.now() - started);
    if (result.stdout.length > 0) shown += 1;
  }
  times.sort((a, b) => a - b);
  const fmt = (value) => value.toFixed(0);
  console.log(`${label}: ${runs} calls, p50 ${fmt(percentile(times, 50))} ms, p95 ${fmt(percentile(times, 95))} ms, max ${fmt(times.at(-1))} ms, ${shown} with output, load ${loadavg()[0].toFixed(1)}`);
}

const runs = Number(process.argv[2] ?? 100);
bench('lexical', runs, {});
if (process.argv.includes('--embed')) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-memory-bench-'));
  const config = mergeConfig(loadConfig(), { embedding: { enabled: true } });
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
  bench('embedding (forced ollama)', runs, { AGENT_MEMORY_CONFIG: join(dir, 'config.json'), AGENT_MEMORY_FORCE_BACKEND: 'ollama' });
}
