import path from 'node:path';
import { git } from './exec.mjs';

export const BASE_REF = 'origin/main';

export function normalizePaths(root, paths) {
  return [...new Set(paths.map((entry) => {
    const absolute = path.resolve(root, String(entry));
    return path.relative(root, absolute).split(path.sep).join('/');
  }))].filter((entry) => entry && !entry.startsWith('..'));
}

export function parsePorcelainZ(output) {
  const entries = output.split('\0');
  const paths = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    if (/[RC]/.test(entry.slice(0, 2))) index += 1;
  }
  return paths;
}

export function changedPaths(root, env) {
  const options = { env, timeoutMs: 10000 };
  try {
    git(root, ['rev-parse', '--verify', '--quiet', `${BASE_REF}^{commit}`], options);
  } catch {
    throw new Error(`${BASE_REF} not found in ${root}. Run \`git fetch origin main\` or pass paths.`);
  }
  const committed = git(root, ['diff', '--name-only', `${BASE_REF}...HEAD`], options).split('\n').filter(Boolean);
  const working = parsePorcelainZ(git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], options));
  return normalizePaths(root, [...committed, ...working]).sort();
}

export function resolvePaths(root, env, paths) {
  if (paths === undefined) return { base: `${BASE_REF}...HEAD + working tree`, paths: changedPaths(root, env) };
  if (!Array.isArray(paths) || paths.some((entry) => typeof entry !== 'string')) {
    throw new Error('paths must be an array of strings');
  }
  return { base: 'arguments', paths: normalizePaths(root, paths) };
}

export const pathsSchema = {
  type: 'array',
  items: { type: 'string' },
  description: `Repo-relative paths. Defaults to the files changed against ${BASE_REF} plus the working tree.`,
};
