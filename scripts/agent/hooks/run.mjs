#!/usr/bin/env node
// Usage: node scripts/agent/hooks/run.mjs <claude|codex|cursor> <pre-shell|stop>
// Reads the hook event JSON on stdin. Any error exits 0 without blocking.
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { TOOLS, allowOutput, denyOutput, failOpenOutput, stopOutput } from './output.mjs';

export function shellCommand(input) {
  const command = input.tool_input?.command ?? input.command;
  if (typeof command === 'string') return command;
  if (!Array.isArray(command)) return '';
  return /^-\w*c$/.test(command[1] ?? '') ? String(command.at(-1)) : command.join(' ');
}

export async function decide(tool, event, input) {
  if (event === 'pre-shell') {
    const command = shellCommand(input);
    if (!/\b(git|gh)\b/.test(command)) return allowOutput(tool);
    const { stashBlockReason } = await import('./stash.mjs');
    const stashReason = stashBlockReason(command);
    if (stashReason) return denyOutput(tool, stashReason);
    const { mergeBlockReason } = await import('./merge.mjs');
    const mergeReason = mergeBlockReason(command, { cwd: input.cwd ?? input.workspace_roots?.[0] });
    return mergeReason ? denyOutput(tool, mergeReason) : allowOutput(tool);
  }
  if (event === 'stop') {
    const { stopWarning } = await import('./stop.mjs');
    return stopOutput(tool, stopWarning(input));
  }
  throw new Error(`unknown event ${event}`);
}

async function main() {
  const [tool, event] = process.argv.slice(2);
  let output;
  try {
    if (!TOOLS.has(tool)) throw new Error(`unknown tool ${tool}`);
    const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
    output = await decide(tool, event, input);
  } catch (error) {
    process.stderr.write(`agent hook ${tool} ${event} allowed after an error: ${error?.message ?? error}\n`);
    output = failOpenOutput(tool, event);
  }
  if (output) process.stdout.write(`${output}\n`);
  process.exitCode = 0;
}

function invokedDirectly() {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) await main();
