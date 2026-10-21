import { worktreeState } from '../lib/git-state.mjs';

export function stopDirectory(input) {
  return input.cwd ?? input.workspace_roots?.[0] ?? process.cwd();
}

// Claude Code and Codex set stop_hook_active on a continued turn; Cursor counts follow-ups in loop_count.
export function alreadyContinued(input) {
  return input.stop_hook_active === true || Number(input.loop_count) > 0;
}

export function describeState(state) {
  if (state.error) return null;
  const parts = [];
  if (state.dirty) parts.push(`${state.dirty} uncommitted change${state.dirty === 1 ? '' : 's'}`);
  if (state.unpushed) {
    const target = state.upstream ? `ahead of ${state.upstream}` : 'on no remote branch';
    parts.push(`${state.unpushed} unpushed commit${state.unpushed === 1 ? '' : 's'} ${target}`);
  }
  if (!parts.length) return null;
  return [
    `Worktree ${state.path} (branch ${state.branch}) has ${parts.join(' and ')}.`,
    'Worktrees get deleted, and local work goes with them.',
    'Commit and push to a branch, or tell the user why the work stays local.',
  ].join(' ');
}

export function stopWarning(input, { timeoutMs = 1500 } = {}) {
  if (alreadyContinued(input)) return null;
  return describeState(worktreeState(stopDirectory(input), { timeoutMs }));
}
