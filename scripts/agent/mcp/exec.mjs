import { execFileSync } from 'node:child_process';

export function run(command, args, { cwd, env = process.env, timeoutMs = 5000 } = {}) {
  return execFileSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function tryRun(command, args, options) {
  try {
    return { ok: true, stdout: run(command, args, options).trim() };
  } catch (error) {
    const stderr = String(error?.stderr ?? '').trim();
    return { ok: false, error: (stderr || String(error?.message ?? error)).split('\n')[0] };
  }
}

export function git(root, args, options = {}) {
  return run('git', ['-C', root, ...args], options);
}
