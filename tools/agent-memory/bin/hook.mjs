#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { closeSync, openSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cacheDir, loadConfig } from '../lib/config.mjs';
import { appendLog, runHook } from '../lib/run.mjs';

const HARD_LIMIT_MS = 2000;
const REBUILD_LOCK_MS = 60_000;

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index].startsWith('--')) args[argv[index].slice(2)] = argv[index + 1];
  }
  return args;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/** Rebuilds a stale index in a detached process so this call answers from the old one. */
function rebuildInBackground(config, repo) {
  const lock = join(cacheDir(config), 'rebuild.lock');
  try {
    if (Date.now() - statSync(lock).mtimeMs < REBUILD_LOCK_MS) return;
  } catch {
    // no lock yet
  }
  writeFileSync(lock, String(process.pid));
  const script = fileURLToPath(new URL('./index.mjs', import.meta.url));
  const out = openSync('/dev/null', 'a');
  const child = spawn(process.execPath, [script, ...(repo ? ['--repo', repo] : [])], { detached: true, stdio: ['ignore', out, out] });
  child.unref();
  closeSync(out);
}

async function main() {
  setTimeout(() => process.exit(0), HARD_LIMIT_MS).unref();
  if (process.env.AGENT_MEMORY_DISABLED === '1') return;
  const args = parseArgs(process.argv.slice(2));
  const input = JSON.parse((await readStdin()) || '{}');
  const config = loadConfig();
  const event = args.event ?? input.hook_event_name;
  const result = await runHook({ tool: args.tool ?? 'claude', event, input, config, project: args.project, onStale: (repo) => rebuildInBackground(config, repo) });
  if (result.stdout) process.stdout.write(result.stdout);
  appendLog(result.dir, result.log);
}

main().catch((error) => {
  try {
    appendLog(cacheDir(loadConfig()), { at: new Date().toISOString(), error: String(error?.stack ?? error) });
  } catch {
    // fail open
  }
  process.exit(0);
});
