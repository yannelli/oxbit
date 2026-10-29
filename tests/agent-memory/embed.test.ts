import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error plain-node module without types
import { DEFAULT_CONFIG, mergeConfig } from "../../tools/agent-memory/lib/config.mjs";
// @ts-expect-error plain-node module without types
import { buildVectorCache, fuseRrf, semanticSearch } from "../../tools/agent-memory/lib/embed.mjs";

const VOCAB = ["invoice", "ledger", "export", "tax", "ollama", "embedding", "theme", "color"];

function bagOfWords(text: string) {
  const words = text.toLowerCase().split(/[^a-z]+/);
  return VOCAB.map((term) => words.filter((word) => word === term).length + 0.01);
}

const fake = { delayMs: 0, requests: [] as { model: string; input: string[]; options?: unknown }[] };
let server: Server;
let dir: string;
let ollamaUrl: string;

beforeAll(async () => {
  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const parsed = JSON.parse(body);
      fake.requests.push(parsed);
      const reply = () => {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ model: parsed.model, embeddings: parsed.input.map(bagOfWords) }));
      };
      if (fake.delayMs > 0) setTimeout(reply, fake.delayMs);
      else reply();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  ollamaUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dir = mkdtempSync(join(tmpdir(), "agent-memory-embed-"));
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

function chunk(id: string, title: string, text: string) {
  return { id, path: `/notes/${id}.md`, line: 1, title, description: "", text, hash: `hash-${id}-${text.length}` };
}

const chunks = [
  chunk("invoice", "Invoice export", "The ledger export writes each invoice with its tax line."),
  chunk("theme", "Theme editor", "Theme color tokens drive the editor color swatches."),
  chunk("ollama", "Embedding backend", "Ollama serves the embedding model on localhost."),
];

function config() {
  return mergeConfig(DEFAULT_CONFIG, { embedding: { enabled: true, model: "fake-embed", ollamaUrl } });
}

const choice = { ok: true, backend: "ollama", device: "cpu", model: "fake-embed", reasons: [] };

describe("vector cache and semantic search", () => {
  it("embeds every chunk once, then ranks the matching chunk first", async () => {
    fake.delayMs = 0;
    fake.requests.length = 0;
    const built = await buildVectorCache(chunks, choice, config(), dir);
    expect(built).toMatchObject({ total: 3, embedded: 3 });
    expect(fake.requests[0]).toMatchObject({ model: "fake-embed", options: { num_gpu: 0 } });

    const again = await buildVectorCache(chunks, choice, config(), dir);
    expect(again).toMatchObject({ total: 3, embedded: 0 });

    const result = await semanticSearch("which ledger export has the invoice tax", choice, config(), { dir, deadlineMs: 2000 });
    expect(result).toMatchObject({ used: true, reason: "ok" });
    expect(result.hits).toHaveLength(3);
    expect(result.hits[0].id).toBe("invoice");
    expect(result.hits[0].score).toBeGreaterThan(result.hits[1].score);
  });

  it("returns timeout within the deadline plus 50 ms when the server is slow", async () => {
    fake.delayMs = 1000;
    const deadlineMs = 100;
    const started = performance.now();
    const result = await semanticSearch("release tag", choice, config(), { dir, deadlineMs });
    const elapsed = performance.now() - started;
    fake.delayMs = 0;
    expect(result).toMatchObject({ used: false, reason: "timeout", hits: [] });
    expect(elapsed).toBeLessThanOrEqual(deadlineMs + 50);
  });

  it("returns no-cache when the vector cache is missing", async () => {
    const empty = mkdtempSync(join(tmpdir(), "agent-memory-empty-"));
    const result = await semanticSearch("release", choice, config(), { dir: empty, deadlineMs: 500 });
    rmSync(empty, { recursive: true, force: true });
    expect(result).toMatchObject({ used: false, reason: "no-cache", hits: [] });
  });
});

describe("fuseRrf", () => {
  it("orders ids by summed reciprocal rank", () => {
    const fused = fuseRrf([[{ id: "a" }, { id: "b" }, { id: "c" }], [{ id: "c" }, { id: "a" }, { id: "d" }]]);
    expect(fused.map((entry: { id: string }) => entry.id)).toEqual(["a", "c", "b", "d"]);
    expect(fused[0].score).toBeCloseTo(1 / 61 + 1 / 62, 10);
    expect(fused[3].score).toBeCloseTo(1 / 63, 10);
  });
});
