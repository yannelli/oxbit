import { existsSync, readdirSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { worktreeState } from '../lib/git-state.mjs';
import { git } from './exec.mjs';

export function worktreeRoots(env) {
  const configured = env.OXBIT_WORKTREE_ROOTS;
  if (configured) return configured.split(path.delimiter).filter(Boolean);
  return [path.join(env.HOME ?? os.homedir(), '.paseo', 'worktrees')];
}

function childDirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

const isCheckout = (dir) => existsSync(path.join(dir, '.git'));

export function scanRoot(root) {
  const found = [];
  for (const dir of childDirs(root)) {
    if (isCheckout(dir)) found.push(dir);
    else found.push(...childDirs(dir).filter(isCheckout));
  }
  return found;
}

export function listedWorktrees(repo, env) {
  try {
    return git(repo, ['worktree', 'list', '--porcelain'], { env, timeoutMs: 5000 })
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.slice(9));
  } catch {
    return [];
  }
}

function canonical(dir) {
  try {
    return realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

export function unpushedWork({ repo, env, includeClean = false, timeoutMs = 2000 }) {
  const roots = worktreeRoots(env);
  const seen = new Map();
  for (const dir of [...roots.flatMap(scanRoot), ...listedWorktrees(repo, env)]) {
    const key = canonical(dir);
    if (!seen.has(key)) seen.set(key, dir);
  }
  const states = [...seen.values()].map((dir) => worktreeState(dir, { timeoutMs }));
  const errors = states.filter((state) => state.error);
  const atRisk = states
    .filter((state) => !state.error && (state.dirty > 0 || state.unpushed > 0))
    .sort((a, b) => b.unpushed + b.dirty - (a.unpushed + a.dirty) || a.path.localeCompare(b.path));
  const clean = states.filter((state) => !state.error && state.dirty === 0 && state.unpushed === 0);
  return {
    roots,
    scanned: states.length,
    atRisk,
    clean: includeClean ? clean : clean.length,
    errors,
  };
}

export const unpushedWorkTool = {
  definition: {
    name: 'unpushed_work',
    title: 'Worktrees with unpushed or uncommitted work',
    description:
      'List worktrees under ~/.paseo/worktrees (<id>/<name>, or the roots in OXBIT_WORKTREE_ROOTS separated by ":") and `git worktree list` ' +
      'of this repo. `atRisk` holds the ones with uncommitted changes (`dirty`) or commits no remote has (`unpushed`); push or ' +
      'report them before deleting a worktree or ending a session.',
    inputSchema: {
      type: 'object',
      properties: { includeClean: { type: 'boolean', description: 'List clean worktrees too. Default false returns their count.' } },
      additionalProperties: false,
    },
  },
  run(args, ctx) {
    return unpushedWork({ repo: ctx.root, env: ctx.env, includeClean: args.includeClean === true });
  },
};
