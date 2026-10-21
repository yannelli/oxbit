import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error plain-node module without types
import { DEFAULT_CONFIG, mergeConfig } from "../../tools/agent-memory/lib/config.mjs";
// @ts-expect-error plain-node module without types
import { parsePmset, parseVmStat, pickBackend } from "../../tools/agent-memory/lib/resources.mjs";

type Power = { onAc: boolean; percent: number | null; lowPower: boolean } | null;

const MODEL = "embeddinggemma:300m-qat-q8_0";
const dirs: string[] = [];

function config(embedding: Record<string, unknown> = {}) {
  return mergeConfig(DEFAULT_CONFIG, { embedding: { enabled: true, ...embedding } });
}

function probes(overrides: Record<string, unknown> = {}) {
  return {
    cpus: vi.fn(() => 10),
    loadAverage: vi.fn(() => 2),
    freeMemoryMb: vi.fn(async () => 16_000),
    power: vi.fn(async (): Promise<Power> => ({ onAc: true, percent: 100, lowPower: false })),
    gpu: vi.fn(async () => true),
    ollamaModels: vi.fn(async (): Promise<string[] | null> => [MODEL]),
    llamacppHealthy: vi.fn(async () => false),
    mlxAvailable: vi.fn(async () => ({ module: false, modelDir: false })),
    ...overrides,
  };
}

const noEnv = { env: {} };

function tempCacheFile() {
  const dir = mkdtempSync(join(tmpdir(), "agent-memory-resources-"));
  dirs.push(dir);
  return join(dir, "backend.json");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("pickBackend", () => {
  it("returns disabled without calling any probe", async () => {
    const p = probes();
    const result = await pickBackend(config({ enabled: false }), { probes: p, ...noEnv });
    expect(result).toMatchObject({ ok: false, reasons: ["disabled"] });
    for (const probe of Object.values(p)) expect(probe).not.toHaveBeenCalled();
  });

  it("picks ollama on the GPU on a machine that passes every check", async () => {
    const result = await pickBackend(config(), { probes: probes(), ...noEnv });
    expect(result).toEqual({ ok: true, backend: "ollama", device: "gpu", model: MODEL, reasons: [] });
  });

  it.each([
    ["low memory", { freeMemoryMb: vi.fn(async () => 1000) }, /free memory 1000 MB < 2388 MB/],
    ["too few CPUs", { cpus: vi.fn(() => 2), loadAverage: vi.fn(() => 0) }, /cpus 2 < 4/],
    ["high load", { loadAverage: vi.fn(() => 60) }, /load 6.00\/cpu > 1/],
    [
      "battery below the minimum",
      { power: vi.fn(async () => ({ onAc: false, percent: 30, lowPower: false })) },
      /battery 30% < 50%/,
    ],
    ["Low Power Mode", { power: vi.fn(async () => ({ onAc: true, percent: 100, lowPower: true })) }, /low power mode/],
  ])("fails on %s and skips the model probes", async (_name, overrides, reason) => {
    const p = probes(overrides);
    const result = await pickBackend(config(), { probes: p, ...noEnv });
    expect(result.ok).toBe(false);
    expect(result.backend).toBeNull();
    expect(result.reasons.join("; ")).toMatch(reason);
    expect(p.ollamaModels).not.toHaveBeenCalled();
  });

  it("fails on battery when battery use is off", async () => {
    const p = probes({ power: vi.fn(async () => ({ onAc: false, percent: 90, lowPower: false })) });
    const result = await pickBackend(config({ allowOnBattery: false }), { probes: p, ...noEnv });
    expect(result).toMatchObject({ ok: false, reasons: ["on battery"] });
  });

  it("fails when the model is missing from every backend", async () => {
    const p = probes({ ollamaModels: vi.fn(async () => ["nomic-embed-text:latest"]) });
    const result = await pickBackend(config(), { probes: p, ...noEnv });
    expect(result.ok).toBe(false);
    expect(result.reasons).toEqual([
      `ollama: model ${MODEL} missing`,
      "llamacpp: no /health answer at http://127.0.0.1:8080",
      "mlx: python3 cannot import mlx_embeddings",
    ]);
  });

  it("falls through to llama.cpp and mlx in order", async () => {
    const llama = await pickBackend(config(), {
      probes: probes({ ollamaModels: vi.fn(async () => null), llamacppHealthy: vi.fn(async () => true), gpu: vi.fn(async () => false) }),
      ...noEnv,
    });
    expect(llama).toMatchObject({ ok: true, backend: "llamacpp", device: "cpu", model: MODEL });
    const mlx = await pickBackend(config(), {
      probes: probes({ ollamaModels: vi.fn(async () => null), mlxAvailable: vi.fn(async () => ({ module: true, modelDir: true })) }),
      ...noEnv,
    });
    expect(mlx).toMatchObject({ ok: true, backend: "mlx", device: "mlx", model: "mlx-community/embeddinggemma-300m-4bit" });
  });

  it("uses the cache file within the TTL and probes again after it", async () => {
    const cacheFile = tempCacheFile();
    let clock = 1_000;
    const now = () => clock;
    const first = probes();
    await pickBackend(config(), { probes: first, now, cacheFile, ...noEnv });
    expect(first.ollamaModels).toHaveBeenCalledTimes(1);

    clock += 59_000;
    const second = probes();
    const cached = await pickBackend(config(), { probes: second, now, cacheFile, ...noEnv });
    expect(cached).toMatchObject({ ok: true, backend: "ollama" });
    for (const probe of Object.values(second)) expect(probe).not.toHaveBeenCalled();

    clock += 2_000;
    const third = probes();
    await pickBackend(config(), { probes: third, now, cacheFile, ...noEnv });
    expect(third.ollamaModels).toHaveBeenCalledTimes(1);
  });

  it("skips thresholds but still checks presence when a backend is forced", async () => {
    const p = probes({ loadAverage: vi.fn(() => 130), freeMemoryMb: vi.fn(async () => 10) });
    const env = { AGENT_MEMORY_FORCE_BACKEND: "ollama" };
    const forced = await pickBackend(config(), { probes: p, env });
    expect(forced).toMatchObject({ ok: true, backend: "ollama", device: "gpu" });
    expect(p.freeMemoryMb).not.toHaveBeenCalled();

    const missing = probes({ ollamaModels: vi.fn(async () => []) });
    const result = await pickBackend(config(), { probes: missing, env });
    expect(result).toMatchObject({ ok: false, reasons: [`ollama: model ${MODEL} missing`] });
  });
});

describe("system parsers", () => {
  it("adds free, inactive, speculative and purgeable pages from vm_stat", () => {
    const text = [
      "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
      "Pages free:                                 64.",
      "Pages active:                             9999.",
      "Pages inactive:                            128.",
      "Pages speculative:                          64.",
      "Pages purgeable:                            0.",
    ].join("\n");
    expect(parseVmStat(text)).toBe(4);
  });

  it("reads AC, battery percent and Low Power Mode from pmset", () => {
    const batt = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t42%; discharging; 3:00 remaining";
    expect(parsePmset(batt, " lowpowermode         1\n")).toEqual({ onAc: false, percent: 42, lowPower: true });
    expect(parsePmset("Now drawing from 'AC Power'\n", "")).toEqual({ onAc: true, percent: null, lowPower: false });
  });
});
