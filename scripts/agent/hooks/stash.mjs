import { simpleCommands } from './shell-words.mjs';

const GIT_OPTIONS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env']);
const PUSH_SUBCOMMANDS = new Set(['push', 'save']);
const BLOCKED_SUBCOMMANDS = new Set(['pop', 'clear']);

export const STASH_BLOCK_MESSAGE = [
  'Blocked: the git stash stack is shared by every worktree of this repo, and other sessions push and pop it.',
  'A bare `git stash`, `git stash pop` or `git stash clear` can take or delete another session\'s changes.',
  'Use a WIP commit, or `git stash push -u -m "<unique-tag>"`, find its sha with `git stash list --format=\'%H %gs\'`, then `git stash apply <sha>`.',
].join(' ');

export function gitSubcommandArgs(words) {
  if (words[0] !== 'git') return null;
  let index = 1;
  while (index < words.length && words[index].startsWith('-')) {
    index += GIT_OPTIONS_WITH_VALUE.has(words[index]) ? 2 : 1;
  }
  return words.slice(index);
}

function hasMessage(args, subcommand) {
  if (subcommand === 'save' && args.slice(1).some((arg) => !arg.startsWith('-'))) return true;
  return args.some((arg, index) => {
    if (arg === '--message' || /^-[^-]*m$/.test(arg)) return Boolean(args[index + 1]);
    return arg.startsWith('--message=') || /^-[^-]*m./.test(arg);
  });
}

export function isBlockedStash(args) {
  if (args[0] !== 'stash') return false;
  const rest = args.slice(1);
  const subcommand = rest[0];
  if (subcommand === undefined) return true;
  if (BLOCKED_SUBCOMMANDS.has(subcommand)) return true;
  if (PUSH_SUBCOMMANDS.has(subcommand) || subcommand.startsWith('-')) return !hasMessage(rest, subcommand);
  return false;
}

export function stashBlockReason(command) {
  for (const words of simpleCommands(command)) {
    const args = gitSubcommandArgs(words);
    if (args && isBlockedStash(args)) return STASH_BLOCK_MESSAGE;
  }
  return null;
}
