#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { checksForPathsTool } from './checks.mjs';
import { docsForPathsTool } from './docs.mjs';
import { doctorTool } from './doctor.mjs';
import { ledgerTools } from './ledger.mjs';
import { createHandler } from './rpc.mjs';
import { staleWorkTool } from './stale.mjs';
import { unpushedWorkTool } from './unpushed.mjs';

export const tools = [checksForPathsTool, docsForPathsTool, unpushedWorkTool, ...ledgerTools, doctorTool, staleWorkTool];

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const INSTRUCTIONS =
  'Oxbit agent tools. Before pushing, run checks_for_paths and docs_for_paths. Before deleting a worktree or ending a session, ' +
  'run unpushed_work. At session start, run ledger_list for open questions. When git, gh or signing fails, run doctor.';

function log(message) {
  process.stderr.write(`[oxbit-mcp] ${message}\n`);
}

export function startServer({ input = process.stdin, output = process.stdout, root = repoRoot, env = process.env } = {}) {
  const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const handle = createHandler({
    tools,
    ctx: { root, env, platform: process.platform },
    serverInfo: { name: 'oxbit-agent-tools', title: 'Oxbit agent tools', version },
    instructions: INSTRUCTIONS,
  });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let queue = Promise.resolve();
  lines.on('line', (line) => {
    if (!line.trim()) return;
    queue = queue
      .then(() => handle(line))
      .then((response) => {
        if (response) output.write(`${JSON.stringify(response)}\n`);
      })
      .catch((error) => log(error?.stack ?? String(error)));
  });
  lines.on('close', () => {
    queue.then(() => process.exit(0));
  });
  log(`started in ${root}`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) startServer();
