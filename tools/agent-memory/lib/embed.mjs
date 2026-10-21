import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cacheDir } from './config.mjs';

const BATCH_SIZE = 32;
const DEFAULT_LIMIT = 20;
const MLX_SERVER = fileURLToPath(new URL('./mlx_server.py', import.meta.url));

class MlxStartingError extends Error {
  code = 'MLX_STARTING';
}

async function postJson(url, body, signal) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.json();
}

function startMlxServer(e) {
  const child = spawn('python3', [MLX_SERVER, '--port', String(e.mlxPort), '--model', e.mlxModel], {
    detached: true,
    stdio: 'ignore',
  });
  child.on('error', () => {});
  child.unref();
}

async function embedMlx(texts, e, signal) {
  try {
    const body = await postJson(`http://127.0.0.1:${e.mlxPort}/embed`, { input: texts }, signal);
    return body.embeddings;
  } catch (error) {
    if (signal?.aborted || error?.cause?.code !== 'ECONNREFUSED') throw error;
    startMlxServer(e);
    throw new MlxStartingError('mlx sidecar was not running; started it');
  }
}

async function embedRaw(texts, choice, e, signal) {
  const model = choice.model ?? e.model;
  if (choice.backend === 'ollama') {
    const body = { model, input: texts };
    if (choice.device === 'cpu') body.options = { num_gpu: 0 };
    return (await postJson(`${e.ollamaUrl}/api/embed`, body, signal)).embeddings;
  }
  if (choice.backend === 'llamacpp') {
    const body = await postJson(`${e.llamacppUrl}/v1/embeddings`, { model, input: texts }, signal);
    return [...body.data].sort((a, b) => a.index - b.index).map((entry) => entry.embedding);
  }
  if (choice.backend === 'mlx') return embedMlx(texts, e, signal);
  throw new Error(`unknown backend ${choice.backend}`);
}

export async function embedTexts(texts, choice, config, { signal } = {}) {
  const vectors = await embedRaw(texts, choice, config.embedding, signal);
  if (!Array.isArray(vectors) || vectors.length !== texts.length) {
    throw new Error(`expected ${texts.length} embeddings, got ${vectors?.length ?? 0}`);
  }
  return vectors.map((vector) => Float32Array.from(vector));
}

function normalize(vector) {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const norm = Math.sqrt(sum) || 1;
  for (let i = 0; i < vector.length; i += 1) vector[i] /= norm;
  return vector;
}

function usesGemmaPrompts(model) {
  return /embeddinggemma/i.test(model ?? '');
}

// EmbeddingGemma expects these task prefixes on documents and queries (model card).
function documentText(chunk, model) {
  const body = [chunk.description, chunk.text].filter(Boolean).join('\n');
  return usesGemmaPrompts(model) ? `title: ${chunk.title || 'none'} | text: ${body}` : [chunk.title, body].join('\n');
}

function queryText(query, model) {
  return usesGemmaPrompts(model) ? `task: search result | query: ${query}` : query;
}

function cacheFiles(dir, model) {
  const base = join(dir, `vectors-${String(model).replace(/[^A-Za-z0-9._-]+/g, '-')}`);
  return { meta: `${base}.json`, bin: `${base}.bin` };
}

function readVectorCache(dir, model) {
  const files = cacheFiles(dir, model);
  if (!existsSync(files.meta) || !existsSync(files.bin)) return null;
  try {
    const meta = JSON.parse(readFileSync(files.meta, 'utf8'));
    const bytes = readFileSync(files.bin);
    const data = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    if (data.length !== meta.ids.length * meta.dims) return null;
    return { ...meta, data };
  } catch {
    return null;
  }
}

function writeAtomic(path, content) {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, content);
  renameSync(temp, path);
}

export async function buildVectorCache(chunks, choice, config, dir) {
  const started = performance.now();
  const model = choice.model ?? config.embedding.model;
  const byHash = new Map();
  const previous = readVectorCache(dir, model);
  if (previous) {
    previous.hashes.forEach((hash, row) => {
      byHash.set(hash, previous.data.slice(row * previous.dims, (row + 1) * previous.dims));
    });
  }
  const missing = [...new Map(chunks.filter((c) => !byHash.has(c.hash)).map((c) => [c.hash, c])).values()];
  for (let start = 0; start < missing.length; start += BATCH_SIZE) {
    const batch = missing.slice(start, start + BATCH_SIZE);
    const vectors = await embedTexts(batch.map((chunk) => documentText(chunk, model)), choice, config);
    batch.forEach((chunk, i) => byHash.set(chunk.hash, normalize(vectors[i])));
  }
  const dims = chunks.length > 0 ? byHash.get(chunks[0].hash).length : 0;
  const data = new Float32Array(chunks.length * dims);
  chunks.forEach((chunk, row) => {
    const vector = byHash.get(chunk.hash);
    if (vector.length !== dims) throw new Error(`vector for ${chunk.id} has ${vector.length} dims, expected ${dims}`);
    data.set(vector, row * dims);
  });
  mkdirSync(dir, { recursive: true });
  const files = cacheFiles(dir, model);
  writeAtomic(files.bin, Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  writeAtomic(files.meta, JSON.stringify({ model, dims, ids: chunks.map((c) => c.id), hashes: chunks.map((c) => c.hash) }));
  return { total: chunks.length, embedded: missing.length, ms: Math.round(performance.now() - started) };
}

function failureReason(error, deadline, signal) {
  if (deadline.aborted) return 'timeout';
  if (signal?.aborted) return 'aborted';
  if (error?.code === 'MLX_STARTING') return 'mlx-starting';
  return `error: ${error?.message ?? error}`;
}

export async function semanticSearch(query, choice, config, { dir, deadlineMs, signal, limit = DEFAULT_LIMIT } = {}) {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const model = choice.model ?? config.embedding.model;
  const cache = readVectorCache(dir ?? cacheDir(config), model);
  if (!cache) return { used: false, reason: 'no-cache', ms: elapsed(), hits: [] };
  const deadline = AbortSignal.timeout(deadlineMs ?? config.embedding.budgetMs);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let vector;
  try {
    [vector] = await embedTexts([queryText(query, model)], choice, config, { signal: combined });
  } catch (error) {
    return { used: false, reason: failureReason(error, deadline, signal), ms: elapsed(), hits: [] };
  }
  if (vector.length !== cache.dims) {
    return { used: false, reason: `dims ${vector.length} != cache ${cache.dims}`, ms: elapsed(), hits: [] };
  }
  normalize(vector);
  const hits = cache.ids.map((id, row) => {
    let score = 0;
    const offset = row * cache.dims;
    for (let i = 0; i < cache.dims; i += 1) score += vector[i] * cache.data[offset + i];
    return { id, score };
  });
  hits.sort((a, b) => b.score - a.score);
  return { used: true, reason: 'ok', ms: elapsed(), hits: hits.slice(0, limit) };
}

export function fuseRrf(lists, k = 60) {
  const scores = new Map();
  for (const list of lists) {
    list.forEach(({ id }, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1)));
  }
  return [...scores].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score);
}
