import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';

const BACKENDS = ['ollama', 'llamacpp', 'mlx'];
const HTTP_TIMEOUT_MS = 300;
const EXEC_TIMEOUT_MS = 1500;
const MB = 1024 * 1024;

function run(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: EXEC_TIMEOUT_MS }, (error, stdout) => resolve(error ? null : stdout));
  });
}

async function fetchWithTimeout(url) {
  try {
    return await fetch(url, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  } catch {
    return null;
  }
}

function readText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

export function parseVmStat(text) {
  const pageSize = Number(/page size of (\d+) bytes/.exec(text)?.[1] ?? 4096);
  const pages = (label) => Number(new RegExp(`Pages ${label}:\\s+(\\d+)`).exec(text)?.[1] ?? 0);
  const total = pages('free') + pages('inactive') + pages('speculative') + pages('purgeable');
  return Math.floor((total * pageSize) / MB);
}

export function parseMemInfo(text) {
  const kb = /MemAvailable:\s+(\d+) kB/.exec(text)?.[1];
  return kb === undefined ? null : Math.floor(Number(kb) / 1024);
}

export function parsePmset(battText, settingsText) {
  const percent = /(\d+)%/.exec(battText ?? '')?.[1];
  return {
    onAc: !/'Battery Power'/.test(battText ?? ''),
    percent: percent === undefined ? null : Number(percent),
    lowPower: /lowpowermode\s+1/i.test(settingsText ?? ''),
  };
}

function linuxPower() {
  const root = '/sys/class/power_supply';
  let names = [];
  try {
    names = readdirSync(root);
  } catch {
    return null;
  }
  let onAc = null;
  let percent = null;
  for (const name of names) {
    const type = readText(join(root, name, 'type'))?.trim();
    if (type === 'Mains') onAc = onAc || readText(join(root, name, 'online'))?.trim() === '1';
    if (type === 'Battery') percent = Number(readText(join(root, name, 'capacity')) ?? NaN);
  }
  if (onAc === null && percent === null) return null;
  return { onAc: onAc ?? false, percent: Number.isNaN(percent) ? null : percent, lowPower: false };
}

function huggingFaceModelDir(model, env) {
  const hub = env.HF_HUB_CACHE || join(env.HF_HOME || join(os.homedir(), '.cache', 'huggingface'), 'hub');
  return join(hub, `models--${model.replaceAll('/', '--')}`);
}

export const defaultProbes = {
  cpus: () => os.availableParallelism(),
  loadAverage: () => os.loadavg()[0],
  async freeMemoryMb() {
    if (process.platform === 'darwin') {
      const text = await run('vm_stat', []);
      if (text) return parseVmStat(text);
    }
    if (process.platform === 'linux') {
      const mb = parseMemInfo(readText('/proc/meminfo') ?? '');
      if (mb !== null) return mb;
    }
    return Math.floor(os.freemem() / MB);
  },
  async power() {
    if (process.platform === 'darwin') {
      const [batt, settings] = await Promise.all([run('pmset', ['-g', 'batt']), run('pmset', ['-g'])]);
      return batt === null ? null : parsePmset(batt, settings);
    }
    return process.platform === 'linux' ? linuxPower() : null;
  },
  async gpu() {
    if (process.platform === 'darwin') return process.arch === 'arm64';
    return existsSync('/dev/nvidiactl') || existsSync('/dev/nvidia0');
  },
  async ollamaModels(url) {
    const response = await fetchWithTimeout(`${url}/api/tags`);
    if (!response?.ok) return null;
    try {
      const body = await response.json();
      return (body.models ?? []).map((entry) => entry.name);
    } catch {
      return null;
    }
  },
  async llamacppHealthy(url) {
    const response = await fetchWithTimeout(`${url}/health`);
    return Boolean(response?.ok);
  },
  async mlxAvailable(model, env = process.env) {
    const modelDir = existsSync(huggingFaceModelDir(model, env));
    const module = (await run('python3', ['-c', 'import mlx_embeddings'])) !== null;
    return { module, modelDir };
  },
};

function thresholdReasons(e, facts) {
  const reasons = [];
  if (facts.cpus < e.minCpus) reasons.push(`cpus ${facts.cpus} < ${e.minCpus}`);
  const loadPerCpu = facts.load / Math.max(facts.cpus, 1);
  if (loadPerCpu > e.maxLoadPerCpu) reasons.push(`load ${loadPerCpu.toFixed(2)}/cpu > ${e.maxLoadPerCpu}`);
  const needMb = e.minFreeMemoryMb + e.modelSizeMb;
  if (facts.memoryMb < needMb) reasons.push(`free memory ${facts.memoryMb} MB < ${needMb} MB`);
  const power = facts.power;
  if (power && !power.onAc) {
    if (!e.allowOnBattery) reasons.push('on battery');
    else if (power.percent !== null && power.percent < e.minBatteryPercent) {
      reasons.push(`battery ${power.percent}% < ${e.minBatteryPercent}%`);
    }
  }
  if (power?.lowPower) reasons.push('low power mode');
  return reasons;
}

function sameModel(listed, wanted) {
  const withTag = (name) => (name.includes(':') ? name : `${name}:latest`);
  return withTag(listed) === withTag(wanted);
}

async function presence(backend, e, probes, env) {
  if (backend === 'ollama') {
    const models = await probes.ollamaModels(e.ollamaUrl);
    if (models === null) return { model: null, reason: `ollama: no answer at ${e.ollamaUrl}` };
    if (!models.some((name) => sameModel(name, e.model))) return { model: null, reason: `ollama: model ${e.model} missing` };
    return { model: e.model };
  }
  if (backend === 'llamacpp') {
    if (await probes.llamacppHealthy(e.llamacppUrl)) return { model: e.model };
    return { model: null, reason: `llamacpp: no /health answer at ${e.llamacppUrl}` };
  }
  if (backend === 'mlx') {
    const { module, modelDir } = await probes.mlxAvailable(e.mlxModel, env);
    if (!module) return { model: null, reason: 'mlx: python3 cannot import mlx_embeddings' };
    if (!modelDir) return { model: null, reason: `mlx: model ${e.mlxModel} missing from Hugging Face cache` };
    return { model: e.mlxModel };
  }
  return { model: null, reason: `unknown backend ${backend}` };
}

async function pickDevice(backend, e, probes) {
  if (e.device !== 'auto') return e.device;
  if (backend === 'mlx') return 'mlx';
  return (await probes.gpu()) ? 'gpu' : 'cpu';
}

function readCache(cacheFile, key, nowMs, ttlMs) {
  const text = cacheFile ? readText(cacheFile) : null;
  if (!text) return null;
  try {
    const cached = JSON.parse(text);
    return cached.key === key && nowMs - cached.at >= 0 && nowMs - cached.at < ttlMs ? cached.result : null;
  } catch {
    return null;
  }
}

function writeCache(cacheFile, key, nowMs, result) {
  if (!cacheFile) return;
  try {
    mkdirSync(dirname(cacheFile), { recursive: true });
    writeFileSync(cacheFile, JSON.stringify({ key, at: nowMs, result }));
  } catch {
    // A missing cache only costs the next call a fresh probe.
  }
}

function fail(reasons) {
  return { ok: false, backend: null, device: null, model: null, reasons };
}

async function probeBackend(e, probes, force, env) {
  if (!force) {
    const [memoryMb, power] = await Promise.all([probes.freeMemoryMb(), probes.power()]);
    const reasons = thresholdReasons(e, { cpus: probes.cpus(), load: probes.loadAverage(), memoryMb, power });
    if (reasons.length > 0) return fail(reasons);
  }
  const candidates = force ? [force] : e.backend === 'auto' ? BACKENDS : [e.backend];
  const reasons = [];
  for (const backend of candidates) {
    const found = await presence(backend, e, probes, env);
    if (found.model === null) {
      reasons.push(found.reason);
      continue;
    }
    const device = await pickDevice(backend, e, probes);
    return { ok: true, backend, device, model: found.model, reasons };
  }
  return fail(reasons);
}

export async function pickBackend(config, { probes, now = Date.now, cacheFile, env = process.env } = {}) {
  const e = config.embedding;
  if (e.enabled === false) return fail(['disabled']);
  const force = env.AGENT_MEMORY_FORCE_BACKEND || null;
  const key = JSON.stringify({ e, force });
  const cached = readCache(cacheFile, key, now(), e.checkTtlMs);
  if (cached) return cached;
  const result = await probeBackend(e, { ...defaultProbes, ...probes }, force, env);
  writeCache(cacheFile, key, now(), result);
  return result;
}
