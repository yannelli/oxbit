import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cacheDir } from './config.mjs';
import { analyzeChunk, buildIndex, encodePostings } from './lexical.mjs';
import { listSourceFiles, readChunks } from './sources.mjs';

function sha1(text) {
  return createHash('sha1').update(text).digest('hex').slice(0, 16);
}

export function indexCachePath(config, { repo, env = process.env } = {}) {
  return join(cacheDir(config, env), `index-${sha1(JSON.stringify([config.sources, config.exclude, repo ?? '']))}.json`);
}

export function writeJsonAtomic(path, value) {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, JSON.stringify(value));
  renameSync(temp, path);
}

function readCache(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

const DOC_KEYS = ['id', 'path', 'line', 'title', 'description', 'lengths'];

function hydrate(cached) {
  const docs = cached.docs.map((row) => Object.fromEntries(DOC_KEYS.map((key, column) => [key, row[column]])));
  return { docs, avg: cached.avg, postings: new Map(Object.entries(cached.postings)) };
}

function analysisPath(path) {
  return path.replace(/\.json$/, '.files.json');
}

/**
 * Returns the lexical index, rebuilt when any source file's mtime or size changed.
 * Unchanged files reuse their cached term counts, so a rebuild reads only changed files.
 */
export function loadIndex(config, { repo, env = process.env, path = indexCachePath(config, { repo, env }), allowStale = false } = {}) {
  const files = listSourceFiles(config, { repo, env });
  const signature = sha1(JSON.stringify(files.map((file) => [file.path, file.mtimeMs, file.size])));
  const cached = readCache(path);
  if (cached?.signature === signature) return { index: hydrate(cached), rebuilt: false, stale: false, files: files.length };
  if (cached && allowStale) return { index: hydrate(cached), rebuilt: false, stale: true, files: files.length };

  const previous = new Map((readCache(analysisPath(path))?.files ?? []).map((entry) => [entry.path, entry]));
  const entries = files.map((file) => {
    const old = previous.get(file.path);
    if (old && old.mtimeMs === file.mtimeMs && old.size === file.size) return old;
    const chunks = readChunks(file).map((chunk) => {
      const { text: _text, ...meta } = chunk;
      return { chunk: meta, analysis: analyzeChunk(chunk) };
    });
    return { ...file, chunks };
  });
  const digests = new Set();
  const unique = entries.flatMap((entry) => entry.chunks).filter(({ chunk }) => !digests.has(chunk.digest) && digests.add(chunk.digest));
  const index = buildIndex(unique);
  mkdirSync(join(path, '..'), { recursive: true });
  writeJsonAtomic(analysisPath(path), { files: entries });
  const docs = index.docs.map((doc) => DOC_KEYS.map((key) => doc[key]));
  writeJsonAtomic(path, { signature, docs, avg: index.avg, postings: encodePostings(index.postings) });
  return { index, rebuilt: true, stale: false, files: files.length };
}
