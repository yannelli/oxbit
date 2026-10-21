#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { disable, TOOLS } from '../lib/install.mjs';
import { findRepo } from '../lib/run.mjs';

const args = process.argv.slice(2);
const toolsFlag = args.indexOf('--tools');
const tools = toolsFlag >= 0 ? args[toolsFlag + 1].split(',') : TOOLS;
const hookPath = fileURLToPath(new URL('./hook.mjs', import.meta.url));
const repoFlag = args.indexOf('--repo');
const repo = repoFlag >= 0 ? resolve(args[repoFlag + 1]) : findRepo(fileURLToPath(new URL('.', import.meta.url)));
for (const tool of tools) {
  const result = disable(tool, { repo, hookPath, dryRun: args.includes('--dry-run') });
  console.log(`${tool}: ${result.removed ? (result.deleted ? 'removed file' : 'removed entries from') : 'nothing in'} ${result.file}`);
}
