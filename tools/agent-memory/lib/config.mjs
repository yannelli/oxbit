import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const DEFAULT_CONFIG = Object.freeze({
  sources: [
    '~/.claude/projects/*/memory/*.md',
    '$CLAUDE_CONFIG_DIR/projects/*/memory/*.md',
    '~/.agents/shared/**/*.md',
    '{repo}/docs/**/*.md',
  ],
  exclude: ['node_modules', '.git', 'MEMORY.md'],
  cacheDir: '~/.cache/agent-memory',
  budget: { maxLines: 3, maxChars: 900, sessionMaxChars: 6000 },
  match: { minScore: 4, minRelative: 0.75, minTerms: 3, strongScore: 7, maxQueryTerms: 24, toolOutputChars: 4000, toolPattern: '^(Bash|Shell|shell|exec_command|run_terminal_cmd)$' },
  resurface: { afterMs: 45 * 60 * 1000, transcriptGrowthBytes: 400_000, callsWithoutTranscript: 120, onCompactLines: 3 },
  embedding: {
    enabled: false,
    backend: 'auto',
    device: 'auto',
    model: 'embeddinggemma:300m-qat-q8_0',
    modelSizeMb: 340,
    ollamaUrl: 'http://127.0.0.1:11434',
    llamacppUrl: 'http://127.0.0.1:8080',
    mlxModel: 'mlx-community/embeddinggemma-300m-4bit',
    mlxPort: 47821,
    budgetMs: 150,
    minScore: 0.5,
    checkTtlMs: 60_000,
    minFreeMemoryMb: 2048,
    minCpus: 4,
    maxLoadPerCpu: 1.0,
    minBatteryPercent: 50,
    allowOnBattery: true,
  },
});

export function configPath(env = process.env) {
  return env.AGENT_MEMORY_CONFIG || join(homedir(), '.config', 'agent-memory', 'config.json');
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function mergeConfig(base, override) {
  const merged = { ...base };
  for (const [key, value] of Object.entries(override ?? {})) {
    merged[key] = isPlainObject(value) && isPlainObject(base[key]) ? mergeConfig(base[key], value) : value;
  }
  return merged;
}

export function loadConfig(env = process.env) {
  const path = configPath(env);
  let user = {};
  if (existsSync(path)) {
    try {
      user = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      user = {};
    }
  }
  return mergeConfig(DEFAULT_CONFIG, user);
}

/** Expands `~`, `$VAR` and `{repo}`. Returns null when a variable is unset. */
export function expandPath(pattern, { repo, env = process.env } = {}) {
  let unresolved = false;
  let out = pattern.replace(/^~(?=\/|$)/, homedir());
  out = out.replace(/\$([A-Z_][A-Z0-9_]*)/g, (_, name) => {
    if (!env[name]) unresolved = true;
    return env[name] ?? '';
  });
  out = out.replace(/\{repo\}/g, () => {
    if (!repo) unresolved = true;
    return repo ?? '';
  });
  return unresolved ? null : resolve(out);
}

export function cacheDir(config, env = process.env) {
  return expandPath(config.cacheDir, { env }) ?? join(homedir(), '.cache', 'agent-memory');
}
