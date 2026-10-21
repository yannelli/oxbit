import { execFileSync } from 'node:child_process';

function git(dir, args, timeoutMs) {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

export function parseStatusV2(output) {
  const state = { branch: null, upstream: null, ahead: 0, behind: 0, dirty: 0 };
  for (const line of output.split('\n')) {
    if (!line) continue;
    if (line.startsWith('# branch.head ')) state.branch = line.slice(14);
    else if (line.startsWith('# branch.upstream ')) state.upstream = line.slice(18);
    else if (line.startsWith('# branch.ab ')) {
      const [ahead, behind] = line.slice(12).split(' ');
      state.ahead = Math.abs(Number(ahead));
      state.behind = Math.abs(Number(behind));
    } else if (!line.startsWith('#')) state.dirty += 1;
  }
  return state;
}

// Without an upstream, commits that no remote-tracking ref contains count as unpushed.
export function worktreeState(dir, { timeoutMs = 2000 } = {}) {
  try {
    const status = parseStatusV2(git(dir, ['status', '--porcelain=v2', '--branch'], timeoutMs));
    const unpushed = status.upstream
      ? status.ahead
      : Number(git(dir, ['rev-list', '--count', 'HEAD', '--not', '--remotes'], timeoutMs).trim());
    return { path: dir, ...status, unpushed };
  } catch (error) {
    return { path: dir, error: String(error?.message ?? error).split('\n')[0] };
  }
}
