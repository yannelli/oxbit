#!/usr/bin/env node
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { cacheDir, loadConfig } from '../lib/config.mjs';
import { loadIndex } from '../lib/index-cache.mjs';
import { findRepo } from '../lib/run.mjs';
import { listSourceFiles, readChunks } from '../lib/sources.mjs';

const args = process.argv.slice(2);
const repoFlag = args.indexOf('--repo');
const repo = repoFlag >= 0 ? args[repoFlag + 1] : findRepo(process.cwd());
const config = loadConfig();
const started = performance.now();
const { index, rebuilt, files } = loadIndex(config, { repo });
console.log(`lexical: ${files} files, ${index.docs.length} chunks, ${index.postings.size} terms, rebuilt ${rebuilt}, ${(performance.now() - started).toFixed(0)} ms`);
rmSync(join(cacheDir(config), 'rebuild.lock'), { force: true });

if (args.includes('--embed')) {
  const { pickBackend } = await import('../lib/resources.mjs');
  const { buildVectorCache } = await import('../lib/embed.mjs');
  const choice = await pickBackend(config, { cacheFile: join(cacheDir(config), 'resources.json') });
  if (!choice.ok) {
    console.log(`embedding skipped: ${choice.reasons.join(', ')}`);
  } else {
    const chunks = listSourceFiles(config, { repo }).flatMap(readChunks);
    const digests = new Set();
    const unique = chunks.filter((chunk) => !digests.has(chunk.digest) && digests.add(chunk.digest));
    const result = await buildVectorCache(unique, choice, config, cacheDir(config));
    console.log(`embedding: ${choice.backend} on ${choice.device}, ${result.embedded} of ${result.total} chunks embedded, ${result.ms} ms`);
  }
}
