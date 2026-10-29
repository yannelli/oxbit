import { spawnSync } from 'node:child_process';
import { simpleCommands } from './shell-words.mjs';

const FLAGS_WITH_VALUE = new Set(['-R', '--repo', '-b', '--body', '-F', '--body-file', '-t', '--subject', '-A', '--author-email', '--match-head-commit']);
const PASSING_BUCKETS = new Set(['pass', 'skipping']);

export function mergeRequest(command) {
  for (const words of simpleCommands(command)) {
    if (words[0] !== 'gh' || words[1] !== 'pr' || words[2] !== 'merge') continue;
    const request = { pr: null, repo: null };
    for (let index = 3; index < words.length; index += 1) {
      const word = words[index];
      if (word === '-R' || word === '--repo') request.repo = words[index + 1] ?? null;
      if (word.startsWith('--repo=')) request.repo = word.slice(7);
      if (FLAGS_WITH_VALUE.has(word)) index += 1;
      else if (!word.startsWith('-') && request.pr === null) request.pr = word;
    }
    return request;
  }
  return null;
}

export function readChecks(args, { cwd, timeoutMs }) {
  const result = spawnSync('gh', args, { cwd, encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error) return { error: `gh ${result.error.code ?? result.error.message}` };
  try {
    const list = JSON.parse(result.stdout);
    if (Array.isArray(list)) return { list };
  } catch {
    // gh printed no JSON; its stderr explains why.
  }
  return { error: result.stderr.trim().split('\n')[0] || `gh exited ${result.status}` };
}

export function checksVerdict(list) {
  const waiting = list.filter((check) => !PASSING_BUCKETS.has(check.bucket));
  if (!waiting.length) return null;
  const names = waiting.slice(0, 8).map((check) => `${check.name} (${check.bucket})`).join(', ');
  const more = waiting.length > 8 ? ` and ${waiting.length - 8} more` : '';
  return [
    `Blocked: ${waiting.length} of ${list.length} checks on this PR are failing or pending: ${names}${more}.`,
    'Wait for pending checks with `gh pr checks <pr> --watch`. Rerun failed jobs once with `gh run rerun <run-id> --failed`;',
    'if they fail again, fix the cause or report the failure to the user before merging.',
  ].join(' ');
}

export function mergeBlockReason(command, { cwd, timeoutMs = 5000, log = (line) => process.stderr.write(`${line}\n`) } = {}) {
  const request = mergeRequest(command);
  if (!request) return null;
  const args = ['pr', 'checks', ...(request.pr ? [request.pr] : []), ...(request.repo ? ['-R', request.repo] : []), '--json', 'name,state,bucket'];
  let checks = readChecks([...args, '--required'], { cwd, timeoutMs });
  if (checks.error && /no required checks/i.test(checks.error)) checks = readChecks(args, { cwd, timeoutMs });
  if (checks.error) {
    log(`agent hook: allowing gh pr merge without a CI check because gh failed: ${checks.error}`);
    return null;
  }
  if (!checks.list.length) {
    log('agent hook: allowing gh pr merge because the PR reports no checks');
    return null;
  }
  return checksVerdict(checks.list);
}
