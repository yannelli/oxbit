// Fixture project "orbit-dash" — all deterministic mock data. Presentation lives in the DC; this file is data only.
export const project = { name: 'orbit-dash', path: '~/code/orbit-dash', description: 'Telemetry dashboard for Orbit devices' };

export const recentProjects = [
  { name: 'orbit-dash', path: '~/code/orbit-dash', branch: 'feat/telemetry-panel', opened: 'Today 12:04' },
  { name: 'paseo-embed', path: '~/code/paseo-embed', branch: 'main', opened: 'Yesterday' },
  { name: 'design-tokens', path: '~/code/design-tokens', branch: 'release/2.1', opened: '3 days ago' },
  { name: 'oxbit-plugins', path: '~/work/oxbit-plugins', branch: 'main', opened: 'Aug 28' },
];

const F = (lang, content, extra = {}) => ({ lang, content, ...extra });

export const files = {
  'package.json': F('json', `{
  "name": "orbit-dash",
  "version": "0.4.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "test": "vitest run",
    "lint": "eslint src --ext .ts,.tsx",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "react": "19.1.0",
    "react-dom": "19.1.0"
  },
  "devDependencies": {
    "@types/react": "^19.1.2",
    "typescript": "^5.9.3",
    "vite": "^6.0.7",
    "vitest": "^3.0.4"
  }
}
`),
  'tsconfig.json': F('json', `{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "skipLibCheck": true,
    "outDir": "dist"
  },
  "include": ["src"]
}
`),
  'README.md': F('md', `# orbit-dash

Telemetry dashboard for Orbit edge devices. Polls device metrics, renders
latency and error charts, and stores the selected device locally.

## Getting started

\`\`\`sh
pnpm install
pnpm dev
\`\`\`

Open http://localhost:5173 and pick a device in the sidebar.

## Telemetry panel

The **telemetry panel** refreshes every 5 seconds through \`useTelemetry\`.
Set \`VITE_API_BASE\` in \`.env.local\` to point at a staging cluster.

## Scripts

- \`pnpm build\` — type-check and bundle
- \`pnpm test\` — run the Vitest suite
- \`pnpm lint\` — ESLint over \`src\`

See [docs/architecture.md](docs/architecture.md) for the data flow.
`),
  'CHANGELOG.md': F('md', `# Changelog

## 0.4.1 — 2026-08-30

- Fix latency chart clipping on narrow viewports
- Bump Vite to 6.0.7

## 0.4.0 — 2026-08-12

- Add device sidebar with local persistence
- Add \`formatBytes\` helper
`),
  'LICENSE': F('txt', `MIT License

Copyright (c) 2026 Orbit Labs

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
`, { readonly: true }),
  '.env.local': F('txt', '', { permission: 'EACCES: permission denied, open \'.env.local\'' }),
  'public/index.html': F('html', `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>orbit-dash</title>
    <link rel="stylesheet" href="/src/styles/tokens.css" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`),
  'src/main.tsx': F('tsx', `import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/globals.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
`),
  'src/App.tsx': F('tsx', `import { useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { Chart } from './components/Chart';
import { Metric } from './components/Metric';
import { Button } from './components/Button';
import { useTelemetry } from './hooks/useTelemetry';
import { config } from './lib/config';

export function App() {
  const [device, setDevice] = useState(config.defaultDevice);
  const { data, loading, error, label } = useTelemetry(device);

  return (
    <div className="app">
      <Sidebar selected={device} onSelect={setDevice} />
      <main className="content">
        <header className="content__header">
          <h1>{device}</h1>
          <span className="content__meta">{label}</span>
          <Button variant="ghost" onClick={() => setDevice(config.defaultDevice)}>
            Reset
          </Button>
        </header>
        {error && <p role="alert">{error}</p>}
        {loading ? (
          <p>Loading telemetry…</p>
        ) : (
          <>
            <section className="metrics">
              <Metric label="Uptime" value={data?.uptime ?? 0} unit="h" />
              <Metric label="Latency" value={data?.latencyMs ?? 0} unit="ms" />
              <Metric label="Errors" value={data?.errors ?? 0} />
            </section>
            <Chart samples={data?.samples ?? []} />
          </>
        )}
      </main>
    </div>
  );
}
`),
  'src/components/Button.tsx': F('tsx', `import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'secondary';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  children: ReactNode;
}

export function Button({ variant = 'primary', children, ...rest }: ButtonProps) {
  return (
    <button className={\`btn btn--\${variant}\`} {...rest}>
      {children}
    </button>
  );
}
`),
  'src/components/Sidebar.tsx': F('tsx', `import { useLocalStorage } from '../hooks/useLocalStorage';
import { config } from '../lib/config';

interface SidebarProps {
  selected: string;
  onSelect: (id: string) => void;
}

export function Sidebar({ selected, onSelect }: SidebarProps) {
  const [devices] = useLocalStorage<string[]>('devices', config.devices);
  const items=devices.map(d=>({id:d,active:d===selected}));

  return (
    <nav className="sidebar" aria-label="Devices">
      <h2 className="sidebar__title">Devices</h2>
      <ul>
        {items.map((item) => (
          <li key={item.id}>
            <button
              className={item.active ? 'is-active' : undefined}
              onClick={() => onSelect(item.id)}
            >
              {item.id}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
`),
  'src/components/Chart.tsx': F('tsx', `import { useEffect, useMemo, useRef } from 'react';
import type { Sample } from '../lib/api';

interface ChartProps {
  samples: Sample[];
  height?: number;
}

export function Chart({ samples, height = 160 }: ChartProps) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const ctx = canvas.current?.getContext('2d');
    if (!ctx || samples.length === 0) return;
    const max = Math.max(...samples.map((s) => s.latencyMs));
    ctx.clearRect(0, 0, ctx.canvas.width, height);
    ctx.beginPath();
    samples.forEach((s, i) => {
      const x = (i / (samples.length - 1)) * ctx.canvas.width;
      const y = height - (s.latencyMs / max) * height;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.strokeStyle = 'var(--accent)';
    ctx.stroke();
  }, [samples, height]);

  return <canvas ref={canvas} className="chart" width={640} height={height} />;
}
`),
  'src/components/Metric.tsx': F('tsx', `interface MetricProps {
  label: string;
  value: number;
  unit?: string;
}

export function Metric({ label, value, unit }: MetricProps) {
  return (
    <div className="metric">
      <span className="metric__label">{label}</span>
      <strong className="metric__value">
        {value.toLocaleString()}
        {unit && <small>{unit}</small>}
      </strong>
    </div>
  );
}
`),
  'src/hooks/useTelemetry.ts': F('ts', `import { useEffect, useState } from 'react';
import { fetchTelemetry, type Telemetry } from '../lib/api';
import { formatBytes } from '../lib/format';

export interface TelemetryState {
  data?: Telemetry;
  loading: boolean;
  error?: string;
}

export function useTelemetry(deviceId: string, intervalMs = 5000) {
  const [data, setData] = useState<Telemetry>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const next = await fetchTelemetry(deviceId);
        if (!cancelled) setData(next);
      } catch (err) {
        if (!cancelled) setError(String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    tick();
    const id = setInterval(tick, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [deviceId, intervalMs]);

  const sampleCount = data.samples.length;
  const label = \`\${sampleCount} samples · \${formatBytes(data?.bytes ?? 0)}\`;

  return { data, loading, error, sampleCount, label };
}
`),
  'src/hooks/useLocalStorage.ts': F('ts', `import { useCallback, useState } from 'react';

export function useLocalStorage<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : initial;
  });

  const set = useCallback(
    (next: T) => {
      setValue(next);
      localStorage.setItem(key, JSON.stringify(next));
    },
    [key],
  );

  return [value, set] as const;
}
`),
  'src/lib/api.ts': F('ts', `import { config } from './config';

export interface Sample {
  at: number;
  latencyMs: number;
}

export interface Telemetry {
  deviceId: string;
  uptime: number;
  latencyMs: number;
  errors: number;
  bytes: number;
  samples: Sample[];
}

export async function fetchTelemetry(deviceId: string): Promise<Telemetry> {
  const res = await fetch(\`\${config.apiBase}/devices/\${deviceId}/telemetry\`);
  if (!res.ok) throw new Error(\`Telemetry request failed: \${res.status}\`);
  return (await res.json()) as Telemetry;
}
`),
  'src/lib/config.ts': F('ts', `export const config = {
  apiBase: import.meta.env.VITE_API_BASE ?? 'http://localhost:8787',
  defaultDevice: 'orbit-01',
  devices: ['orbit-01', 'orbit-02', 'orbit-07', 'relay-a'],
  pollIntervalMs: 5000,
} as const;
`),
  'src/lib/format.ts': F('ts', `const units = ['B', 'KB', 'MB', 'GB'];

/**
 * Format a byte count with a single decimal.
 * @example formatBytes(1536) // "1.5 KB"
 */
export function formatBytes(bytes: number, precision = 1): string {
  if (bytes <= 0) return '0 B';
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return (bytes / 1024 ** i).toFixed(precision) + units[i];
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return \`\${Math.round(ms)} ms\`;
  const s = ms / 1000;
  if (s < 60) return \`\${s.toFixed(1)} s\`;
  const m = Math.floor(s / 60);
    return \`\${m}m \${Math.round(s % 60)}s\`;
}
`, { externallyChanged: true, diskContent: `const units = ['B', 'KB', 'MB', 'GB'];

/**
 * Format a byte count with a single decimal.
 * @example formatBytes(1536) // "1.5 KB"
 */
export function formatBytes(bytes: number, precision = 1): string {
  if (bytes <= 0) return '0 B';
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return \`\${(bytes / 1024 ** i).toFixed(precision)} \${units[i]}\`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return \`\${Math.round(ms)} ms\`;
  const s = ms / 1000;
  if (s < 60) return \`\${s.toFixed(1)} s\`;
  const m = Math.floor(s / 60);
  return \`\${m}m \${Math.round(s % 60)}s\`;
}
` }),
  'src/lib/format.test.ts': F('ts', `import { describe, expect, it } from 'vitest';
import { formatBytes, formatDuration } from './format';

describe('formatBytes', () => {
  it('returns 0 B for empty input', () => expect(formatBytes(0)).toBe('0 B'));
  it('rounds to one decimal', () => expect(formatBytes(1536)).toBe('1.5 KB'));
  it('caps at GB', () => expect(formatBytes(2 ** 40)).toBe('1024.0 GB'));
});

describe('formatDuration', () => {
  it('formats sub-second values', () => expect(formatDuration(420)).toBe('420 ms'));
  it('formats minutes', () => expect(formatDuration(95_000)).toBe('1m 35s'));
});
`),
  'src/lib/cache.ts': F('ts', '', { missing: true }),
  'src/data/metrics.json': F('json', `{
  "metrics": [
    { "id": "uptime", "label": "Uptime", "unit": "h" },
    { "id": "latencyMs", "label": "Latency", "unit": "ms", "threshold": 250, },
    { "id": "errors", "label": "Errors" }
  ],
  "refreshMs": 5000
}
`),
  'src/styles/tokens.css': F('css', `:root {
  --bg: #0f1115;
  --surface: #171a20;
  --fg: #e6e8ec;
  --fg-muted: #9aa1ad;
  --accent: #8bd5ca;
  --danger: #f27a7a;
  --radius: 6px;
  --font-ui: 'Instrument Sans', system-ui, sans-serif;
  --font-mono: 'JetBrains Mono', ui-monospace, monospace;
}
`),
  'src/styles/globals.css': F('css', `@import './tokens.css';

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--bg);
  colour: var(--fg);
  font-family: var(--font-ui);
}

.app {
  display: grid;
  grid-template-columns: 220px 1fr;
  min-height: 100vh;
}

.sidebar { background: var(--surface); padding: 16px; }
.sidebar button.is-active { color: var(--accent); }

.metrics {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}

.metric__value { font-size: 28px; font-variant-numeric: tabular-nums; }
.chart { width: 100%; height: auto; }
`),
  'src/legacy/polyfill.js': F('js', `// Polyfill for environments without structuredClone (removed in 0.5).
var hasClone = typeof globalThis.structuredClone === 'function';

if (!hasClone) {
  globalThis.structuredClone = function (value) {
    return JSON.parse(JSON.stringify(value));
  };
}

export { hasClone };
`),
  'scripts/build.js': F('js', `#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { statSync } from 'node:fs';

const started = Date.now();
execSync('tsc -b && vite build', { stdio: 'inherit' });

const size = statSync('dist/assets').size;
console.log(\`build finished in \${Date.now() - started} ms (\${size} bytes)\`);
`),
  'docs/architecture.md': F('md', `# Architecture

orbit-dash is a single-page React app with no server of its own.

## Data flow

1. \`useTelemetry\` polls \`/devices/:id/telemetry\` every 5 s.
2. Responses are normalised into the \`Telemetry\` type in \`src/lib/api.ts\`.
3. \`App\` renders three \`Metric\` cards and a \`Chart\` from the latest sample set.

## Persistence

The selected device list is stored with \`useLocalStorage\` under the key \`devices\`.

## Open questions

- Should polling pause when the tab is hidden?
- Move formatting helpers to a shared package with **paseo-embed**.
`),
};

// Git base versions for modified files (used by diff views)
export const gitBase = {
  'src/hooks/useTelemetry.ts': files['src/hooks/useTelemetry.ts'].content
    .replace('deviceId: string, intervalMs = 5000', 'deviceId: string')
    .replace('setInterval(tick, intervalMs)', 'setInterval(tick, 5000)')
    .replace('[deviceId, intervalMs]', '[deviceId]')
    .replace(`  const sampleCount = data.samples.length;\n  const label = \`\${sampleCount} samples · \${formatBytes(data?.bytes ?? 0)}\`;\n\n  return { data, loading, error, sampleCount, label };`, `  return { data, loading, error };`)
    .replace(`import { formatBytes } from '../lib/format';\n`, ''),
  'src/components/Chart.tsx': `import { useEffect, useRef } from 'react';
import type { Sample } from '../lib/api';

interface ChartProps {
  samples: Sample[];
}

export function Chart({ samples }: ChartProps) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const ctx = canvas.current?.getContext('2d');
    if (!ctx || samples.length === 0) return;
    const max = Math.max(...samples.map((s) => s.latencyMs));
    ctx.clearRect(0, 0, ctx.canvas.width, 160);
    ctx.beginPath();
    samples.forEach((s, i) => {
      const x = (i / (samples.length - 1)) * ctx.canvas.width;
      const y = 160 - (s.latencyMs / max) * 160;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();
  }, [samples]);

  return <canvas ref={canvas} className="chart" width={640} height={160} />;
}
`,
  'README.md': files['README.md'].content.replace(/## Telemetry panel[\s\S]*?\n\n(?=## Scripts)/, ''),
  'src/lib/cache.ts': `const store = new Map<string, unknown>();

export function cached<T>(key: string, compute: () => T): T {
  if (!store.has(key)) store.set(key, compute());
  return store.get(key) as T;
}
`,
};

export const git = {
  branch: 'feat/telemetry-panel',
  upstream: 'origin/feat/telemetry-panel',
  ahead: 2, behind: 0,
  branches: ['main', 'feat/telemetry-panel', 'fix/chart-clipping', 'release/0.4'],
  changes: [
    { path: 'src/hooks/useTelemetry.ts', status: 'M', staged: false },
    { path: 'src/components/Chart.tsx', status: 'M', staged: true },
    { path: 'src/components/Metric.tsx', status: 'A', staged: false },
    { path: 'src/lib/cache.ts', status: 'D', staged: false },
    { path: 'README.md', status: 'M', staged: false },
  ],
  log: [
    { sha: 'a41f9c2', message: 'Persist selected device list', author: 'Ryan Yannelli', when: '2 h ago' },
    { sha: '7be03d1', message: 'Add useLocalStorage hook', author: 'Ryan Yannelli', when: '3 h ago' },
    { sha: 'c0d2e88', message: 'Bump Vite to 6.0.7', author: 'Mira Osei', when: 'Yesterday' },
  ],
};

export const conflictFile = `export const config = {
<<<<<<< HEAD (Current change)
  apiBase: import.meta.env.VITE_API_BASE ?? 'http://localhost:8787',
  defaultDevice: 'orbit-01',
=======
  apiBase: import.meta.env.VITE_API_BASE ?? 'https://staging.orbit.dev',
  defaultDevice: 'orbit-02',
>>>>>>> origin/main (Incoming change)
  devices: ['orbit-01', 'orbit-02', 'orbit-07', 'relay-a'],
  pollIntervalMs: 5000,
} as const;
`;

// Live diagnostics: a rule is active while `find` is present in the file. `fix` replaces it.
export const diagnosticRules = [
  { id: 'ts2532', path: 'src/hooks/useTelemetry.ts', find: 'data.samples.length', highlight: 'data', severity: 'error', code: 'TS2532', source: 'ts', message: "'data' is possibly 'undefined'.", fix: { title: 'Add optional chain and fallback', replace: 'data?.samples.length ?? 0' } },
  { id: 'ts2322', path: 'src/App.tsx', find: 'variant="ghost"', highlight: '"ghost"', offset: 8, severity: 'error', code: 'TS2322', source: 'ts', message: "Type '\"ghost\"' is not assignable to type 'Variant | undefined'.", fix: { title: "Change to 'secondary'", replace: 'variant="secondary"' } },
  { id: 'ts6133', path: 'src/components/Chart.tsx', find: 'useMemo, ', highlight: 'useMemo', severity: 'warning', code: 'TS6133', source: 'ts', message: "'useMemo' is declared but its value is never read.", fix: { title: 'Remove unused declaration', replace: '' } },
  { id: 'json519', path: 'src/data/metrics.json', find: '250, }', highlight: ',', offset: 3, severity: 'error', code: 'JSON519', source: 'json', message: 'Trailing comma is not permitted in JSON.', fix: { title: 'Remove trailing comma', replace: '250 }' } },
  { id: 'css-unknown', path: 'src/styles/globals.css', find: 'colour: var(--fg);', highlight: 'colour', severity: 'warning', code: 'unknownProperties', source: 'css', message: "Unknown property: 'colour'.", fix: { title: "Rename to 'color'", replace: 'color: var(--fg);' } },
  { id: 'no-var', path: 'src/legacy/polyfill.js', find: 'var hasClone', highlight: 'var', severity: 'info', code: 'no-var', source: 'eslint', message: "Unexpected 'var', use 'let' or 'const' instead.", fix: { title: "Convert to 'const'", replace: 'const hasClone' } },
];

export const symbols = {
  'src/hooks/useTelemetry.ts': [
    { name: 'TelemetryState', kind: 'interface', line: 5, endLine: 9 },
    { name: 'useTelemetry', kind: 'function', line: 11, endLine: 40, children: [
      { name: 'tick', kind: 'function', line: 18, endLine: 27 },
      { name: 'sampleCount', kind: 'variable', line: 36 },
      { name: 'label', kind: 'variable', line: 37 },
    ] },
  ],
  'src/App.tsx': [{ name: 'App', kind: 'function', line: 9, endLine: 41 }],
  'src/components/Button.tsx': [
    { name: 'Variant', kind: 'type', line: 3 },
    { name: 'ButtonProps', kind: 'interface', line: 5, endLine: 8 },
    { name: 'Button', kind: 'function', line: 10, endLine: 16 },
  ],
  'src/components/Sidebar.tsx': [
    { name: 'SidebarProps', kind: 'interface', line: 4, endLine: 7 },
    { name: 'Sidebar', kind: 'function', line: 9, endLine: 31 },
  ],
  'src/components/Chart.tsx': [
    { name: 'ChartProps', kind: 'interface', line: 4, endLine: 7 },
    { name: 'Chart', kind: 'function', line: 9, endLine: 29 },
  ],
  'src/components/Metric.tsx': [
    { name: 'MetricProps', kind: 'interface', line: 1, endLine: 5 },
    { name: 'Metric', kind: 'function', line: 7, endLine: 17 },
  ],
  'src/lib/api.ts': [
    { name: 'Sample', kind: 'interface', line: 3, endLine: 6 },
    { name: 'Telemetry', kind: 'interface', line: 8, endLine: 15 },
    { name: 'fetchTelemetry', kind: 'function', line: 17, endLine: 21 },
  ],
  'src/lib/format.ts': [
    { name: 'units', kind: 'variable', line: 1 },
    { name: 'formatBytes', kind: 'function', line: 7, endLine: 11 },
    { name: 'formatDuration', kind: 'function', line: 13, endLine: 19 },
  ],
  'src/lib/config.ts': [{ name: 'config', kind: 'variable', line: 1, endLine: 6 }],
  'src/hooks/useLocalStorage.ts': [{ name: 'useLocalStorage', kind: 'function', line: 3, endLine: 18 }],
};

export const hovers = {
  useState: { sig: 'function useState<S = undefined>(): [S | undefined, Dispatch<SetStateAction<S | undefined>>]', doc: 'Returns a stateful value, and a function to update it.', source: 'react' },
  useEffect: { sig: 'function useEffect(effect: EffectCallback, deps?: DependencyList): void', doc: 'Accepts a function that contains imperative, possibly effectful code.', source: 'react' },
  fetchTelemetry: { sig: 'function fetchTelemetry(deviceId: string): Promise<Telemetry>', doc: 'Fetches the latest telemetry sample set for a device.', source: 'src/lib/api.ts' },
  formatBytes: { sig: 'function formatBytes(bytes: number, precision?: number): string', doc: 'Format a byte count with a single decimal.\n@example formatBytes(1536) // "1.5 KB"', source: 'src/lib/format.ts' },
  Telemetry: { sig: 'interface Telemetry', doc: 'deviceId, uptime, latencyMs, errors, bytes, samples', source: 'src/lib/api.ts' },
  data: { sig: 'const data: Telemetry | undefined', doc: '', source: '' },
  config: { sig: 'const config: { readonly apiBase: string; readonly defaultDevice: "orbit-01"; … }', doc: '', source: 'src/lib/config.ts' },
  Button: { sig: 'function Button({ variant, children, ...rest }: ButtonProps): JSX.Element', doc: '', source: 'src/components/Button.tsx' },
  Chart: { sig: 'function Chart({ samples, height }: ChartProps): JSX.Element', doc: '', source: 'src/components/Chart.tsx' },
  useTelemetry: { sig: 'function useTelemetry(deviceId: string, intervalMs?: number): { data: Telemetry | undefined; loading: boolean; error: string | undefined; sampleCount: number; label: string; }', doc: '', source: 'src/hooks/useTelemetry.ts' },
};

export const definitions = {
  fetchTelemetry: { path: 'src/lib/api.ts', line: 17 },
  formatBytes: { path: 'src/lib/format.ts', line: 7 },
  formatDuration: { path: 'src/lib/format.ts', line: 13 },
  Telemetry: { path: 'src/lib/api.ts', line: 8 },
  Sample: { path: 'src/lib/api.ts', line: 3 },
  config: { path: 'src/lib/config.ts', line: 1 },
  Button: { path: 'src/components/Button.tsx', line: 10 },
  Chart: { path: 'src/components/Chart.tsx', line: 9 },
  Metric: { path: 'src/components/Metric.tsx', line: 7 },
  Sidebar: { path: 'src/components/Sidebar.tsx', line: 9 },
  useTelemetry: { path: 'src/hooks/useTelemetry.ts', line: 11 },
  useLocalStorage: { path: 'src/hooks/useLocalStorage.ts', line: 3 },
  App: { path: 'src/App.tsx', line: 9 },
};

export const completions = {
  'data.': [
    { label: 'samples', kind: 'field', detail: 'Sample[]', doc: 'Latest latency samples, oldest first.' },
    { label: 'deviceId', kind: 'field', detail: 'string' },
    { label: 'uptime', kind: 'field', detail: 'number', doc: 'Hours since last boot.' },
    { label: 'latencyMs', kind: 'field', detail: 'number' },
    { label: 'errors', kind: 'field', detail: 'number' },
    { label: 'bytes', kind: 'field', detail: 'number', doc: 'Bytes transferred in the sample window.' },
  ],
  'format': [
    { label: 'formatBytes', kind: 'function', detail: '(bytes: number, precision?: number) => string', doc: 'Format a byte count with a single decimal.' },
    { label: 'formatDuration', kind: 'function', detail: '(ms: number) => string', doc: 'Human-readable duration.' },
    { label: 'FormData', kind: 'class', detail: 'lib.dom.d.ts' },
  ],
  'use': [
    { label: 'useState', kind: 'function', detail: 'react' },
    { label: 'useEffect', kind: 'function', detail: 'react' },
    { label: 'useCallback', kind: 'function', detail: 'react' },
    { label: 'useTelemetry', kind: 'function', detail: './hooks/useTelemetry' },
    { label: 'useLocalStorage', kind: 'function', detail: './hooks/useLocalStorage' },
  ],
  'con': [
    { label: 'config', kind: 'variable', detail: './lib/config' },
    { label: 'console', kind: 'variable', detail: 'Console' },
    { label: 'const', kind: 'keyword' },
  ],
};

export const signatures = {
  formatBytes: { label: 'formatBytes(bytes: number, precision?: number): string', params: ['bytes: number', 'precision?: number'], doc: 'Format a byte count with a single decimal.' },
  fetchTelemetry: { label: 'fetchTelemetry(deviceId: string): Promise<Telemetry>', params: ['deviceId: string'], doc: 'Fetches the latest telemetry sample set.' },
  setInterval: { label: 'setInterval(handler: TimerHandler, timeout?: number, ...arguments: any[]): number', params: ['handler: TimerHandler', 'timeout?: number', '...arguments: any[]'] },
};

export const references = {
  formatBytes: [
    { path: 'src/hooks/useTelemetry.ts', line: 3, preview: "import { formatBytes } from '../lib/format';" },
    { path: 'src/hooks/useTelemetry.ts', line: 37, preview: 'const label = `${sampleCount} samples · ${formatBytes(data?.bytes ?? 0)}`;' },
    { path: 'src/lib/format.ts', line: 7, preview: 'export function formatBytes(bytes: number, precision = 1): string {' },
    { path: 'src/lib/format.test.ts', line: 2, preview: "import { formatBytes, formatDuration } from './format';" },
    { path: 'src/lib/format.test.ts', line: 5, preview: "it('returns 0 B for empty input', () => expect(formatBytes(0)).toBe('0 B'));" },
  ],
  fetchTelemetry: [
    { path: 'src/hooks/useTelemetry.ts', line: 2, preview: "import { fetchTelemetry, type Telemetry } from '../lib/api';" },
    { path: 'src/hooks/useTelemetry.ts', line: 20, preview: 'const next = await fetchTelemetry(deviceId);' },
    { path: 'src/lib/api.ts', line: 17, preview: 'export async function fetchTelemetry(deviceId: string): Promise<Telemetry> {' },
  ],
  config: [
    { path: 'src/App.tsx', line: 7, preview: "import { config } from './lib/config';" },
    { path: 'src/App.tsx', line: 10, preview: 'const [device, setDevice] = useState(config.defaultDevice);' },
    { path: 'src/components/Sidebar.tsx', line: 2, preview: "import { config } from '../lib/config';" },
    { path: 'src/lib/api.ts', line: 1, preview: "import { config } from './config';" },
    { path: 'src/lib/config.ts', line: 1, preview: 'export const config = {' },
  ],
};

export const terminals = [
  { id: 't1', name: 'dev', shell: 'zsh', status: 'running', cwd: '~/code/orbit-dash', lines: [
    { t: 'cmd', s: 'pnpm dev' },
    { t: 'dim', s: '> orbit-dash@0.4.1 dev' },
    { t: 'dim', s: '> vite' },
    { t: 'out', s: '' },
    { t: 'ok', s: '  VITE v6.0.7  ready in 412 ms' },
    { t: 'out', s: '' },
    { t: 'out', s: '  ➜  Local:   http://localhost:5173/' },
    { t: 'out', s: '  ➜  Network: use --host to expose' },
    { t: 'dim', s: '  ➜  press h + enter to show help' },
    { t: 'dim', s: '12:04:11 [vite] hmr update /src/components/Chart.tsx' },
    { t: 'dim', s: '12:06:38 [vite] hmr update /src/hooks/useTelemetry.ts' },
  ] },
  { id: 't2', name: 'tests', shell: 'zsh', status: 'failed', exitCode: 1, cwd: '~/code/orbit-dash', lines: [
    { t: 'cmd', s: 'pnpm test' },
    { t: 'dim', s: '> vitest run' },
    { t: 'out', s: '' },
    { t: 'ok', s: ' ✓ src/hooks/useLocalStorage.test.ts (2 tests) 14ms' },
    { t: 'err', s: ' ❯ src/lib/format.test.ts (5 tests | 1 failed) 31ms' },
    { t: 'err', s: '   × formatBytes > rounds to one decimal' },
    { t: 'out', s: "     AssertionError: expected '1.5KB' to be '1.5 KB'" },
    { t: 'out', s: '      ❯ src/lib/format.ts:10:3' },
    { t: 'out', s: '      ❯ src/lib/format.test.ts:6:60' },
    { t: 'out', s: '' },
    { t: 'out', s: ' Test Files  1 failed | 1 passed (2)' },
    { t: 'out', s: '      Tests  1 failed | 6 passed (7)' },
    { t: 'dim', s: '   Start at  12:05:02' },
    { t: 'dim', s: '   Duration  1.24s' },
    { t: 'err', s: 'ELIFECYCLE  Test failed. See above for more details.' },
  ] },
  { id: 't3', name: 'staging', shell: 'ssh', status: 'disconnected', cwd: 'deploy@staging.orbit.dev', lines: [
    { t: 'cmd', s: 'ssh deploy@staging.orbit.dev' },
    { t: 'out', s: 'Last login: Sat Sep  6 11:48:02 2026 from 10.0.4.21' },
    { t: 'cmd', s: 'tail -f /var/log/orbit/api.log' },
    { t: 'out', s: '12:01:44 GET /devices/orbit-01/telemetry 200 38ms' },
    { t: 'out', s: '12:01:49 GET /devices/orbit-01/telemetry 200 41ms' },
    { t: 'err', s: 'client_loop: send disconnect: Broken pipe' },
  ] },
];

// Command scripts for the terminal simulator
export const shellCommands = {
  'pnpm test': [
    { d: 200, t: 'dim', s: '> vitest run' },
    { d: 700, t: 'ok', s: ' ✓ src/hooks/useLocalStorage.test.ts (2 tests) 12ms' },
    { d: 500, t: 'ok', s: ' ✓ src/lib/format.test.ts (5 tests) 27ms' },
    { d: 100, t: 'out', s: '' },
    { d: 100, t: 'out', s: ' Test Files  2 passed (2)' },
    { d: 100, t: 'out', s: '      Tests  7 passed (7)' },
    { d: 100, t: 'dim', s: '   Duration  0.98s' },
  ],
  'pnpm build': [
    { d: 300, t: 'dim', s: '> tsc -b && vite build' },
    { d: 1200, t: 'out', s: 'vite v6.0.7 building for production...' },
    { d: 600, t: 'out', s: '✓ 41 modules transformed.' },
    { d: 200, t: 'out', s: 'dist/index.html                  0.46 kB │ gzip:  0.30 kB' },
    { d: 100, t: 'out', s: 'dist/assets/index-Bx91k2.css     2.11 kB │ gzip:  0.88 kB' },
    { d: 100, t: 'out', s: 'dist/assets/index-D3fk0a.js    214.20 kB │ gzip: 68.41 kB' },
    { d: 100, t: 'ok', s: '✓ built in 1.84s' },
  ],
  'git status': [
    { d: 150, t: 'out', s: 'On branch feat/telemetry-panel' },
    { d: 50, t: 'out', s: "Your branch is ahead of 'origin/feat/telemetry-panel' by 2 commits." },
    { d: 50, t: 'out', s: '' },
    { d: 50, t: 'out', s: 'Changes to be committed:' },
    { d: 50, t: 'ok', s: '\tmodified:   src/components/Chart.tsx' },
    { d: 50, t: 'out', s: '' },
    { d: 50, t: 'out', s: 'Changes not staged for commit:' },
    { d: 50, t: 'err', s: '\tmodified:   src/hooks/useTelemetry.ts' },
    { d: 50, t: 'err', s: '\tmodified:   README.md' },
    { d: 50, t: 'err', s: '\tdeleted:    src/lib/cache.ts' },
  ],
  'ls': [{ d: 80, t: 'out', s: 'CHANGELOG.md  LICENSE  README.md  docs  package.json  public  scripts  src  tsconfig.json' }],
  'pwd': [{ d: 50, t: 'out', s: '/Users/ryan/code/orbit-dash' }],
  'node -v': [{ d: 80, t: 'out', s: 'v22.11.0' }],
  'clear': [],
};

export const tasks = [
  { id: 'typecheck', label: 'typecheck', command: 'tsc --noEmit', group: 'build', script: [
    { d: 400, s: '> tsc --noEmit' },
    { d: 1200, s: 'src/hooks/useTelemetry.ts:36:23 - error TS2532: \'data\' is possibly \'undefined\'.', ref: { path: 'src/hooks/useTelemetry.ts', line: 36, col: 23 } },
    { d: 200, s: 'src/App.tsx:20:19 - error TS2322: Type \'"ghost"\' is not assignable to type \'Variant | undefined\'.', ref: { path: 'src/App.tsx', line: 20, col: 19 } },
    { d: 200, s: 'src/components/Chart.tsx:1:21 - warning TS6133: \'useMemo\' is declared but its value is never read.', ref: { path: 'src/components/Chart.tsx', line: 1, col: 21 } },
    { d: 300, s: '' },
    { d: 100, s: 'Found 2 errors, 1 warning in 3 files.', fail: true },
  ] },
  { id: 'build', label: 'build', command: 'pnpm build', group: 'build', script: [
    { d: 300, s: '> tsc -b && vite build' }, { d: 1200, s: 'vite v6.0.7 building for production...' },
    { d: 600, s: '✓ 41 modules transformed.' }, { d: 200, s: 'dist/assets/index-D3fk0a.js    214.20 kB │ gzip: 68.41 kB' }, { d: 100, s: '✓ built in 1.84s' },
  ] },
  { id: 'test', label: 'test', command: 'pnpm test', group: 'test', script: [
    { d: 300, s: '> vitest run' }, { d: 800, s: ' ✓ src/hooks/useLocalStorage.test.ts (2 tests) 12ms' },
    { d: 500, s: ' ❯ src/lib/format.test.ts (5 tests | 1 failed) 31ms' },
    { d: 100, s: "   × formatBytes > rounds to one decimal — expected '1.5KB' to be '1.5 KB'", ref: { path: 'src/lib/format.ts', line: 10, col: 3 } },
    { d: 100, s: ' Tests  1 failed | 6 passed (7)', fail: true },
  ] },
  { id: 'lint', label: 'lint', command: 'eslint src --ext .ts,.tsx', group: 'test', script: [
    { d: 900, s: 'src/legacy/polyfill.js', ref: { path: 'src/legacy/polyfill.js', line: 2, col: 1 } },
    { d: 100, s: "  2:1  warning  Unexpected var, use let or const instead  no-var" },
    { d: 200, s: '✖ 1 problem (0 errors, 1 warning)' },
  ] },
];

export const outputChannels = {
  'Language Server (TypeScript)': [
    '[12:03:58] Starting TypeScript language server 5.9.3',
    '[12:03:59] Loaded tsconfig.json (14 files)',
    '[12:04:00] Project initialised in 1.2 s',
    '[12:06:38] Diagnostics updated for src/hooks/useTelemetry.ts (1 error)',
  ],
  Git: [
    '> git status --porcelain -z',
    '> git rev-parse --abbrev-ref HEAD',
    'feat/telemetry-panel',
    '> git rev-list --left-right --count feat/telemetry-panel...origin/feat/telemetry-panel',
    '2\t0',
  ],
  Extensions: [
    '[12:03:57] Activating 4 extensions',
    '[12:03:57] oxbit.themes-pack activated in 12 ms',
    '[12:03:57] oxbit.prettier activated in 48 ms',
    '[12:03:58] orbitlabs.bundle-inspector activated in 91 ms (contributes: panel, command, statusItem, documentView)',
  ],
  'Bundle Inspector': [
    '[12:04:02] Analysing dist/ …',
    '[12:04:03] 3 chunks, 214.2 kB total (68.4 kB gzip)',
  ],
};

export const bundleChunks = [
  { name: 'index-D3fk0a.js', size: 214.2, gzip: 68.4, modules: 41 },
  { name: 'vendor-react.js', size: 138.9, gzip: 44.7, modules: 6 },
  { name: 'index-Bx91k2.css', size: 2.1, gzip: 0.9, modules: 2 },
];

export const extensions = [
  { id: 'oxbit.themes-pack', name: 'Oxbit Themes Pack', publisher: 'Oxbit', version: '1.2.0', latest: '1.2.0', installed: true, enabled: true, builtin: true, description: 'Graphite and Paper themes plus four community palettes.', categories: ['Themes'], compat: '≥ 1.0.0', deps: [], permissions: ['Read workbench theme'], contributes: [{ kind: 'theme', name: 'Graphite' }, { kind: 'theme', name: 'Paper' }], installs: '1.2M', versions: ['1.2.0', '1.1.3', '1.0.0'] },
  { id: 'oxbit.prettier', name: 'Prettier', publisher: 'Oxbit', version: '3.4.1', latest: '3.5.0', installed: true, enabled: true, description: 'Opinionated code formatter for TS, JS, CSS, JSON and Markdown.', categories: ['Formatters'], compat: '≥ 1.1.0', deps: [], permissions: ['Read and modify open documents'], contributes: [{ kind: 'formatter', name: 'prettier' }, { kind: 'command', name: 'Format Document with Prettier' }, { kind: 'setting', name: 'prettier.semi' }], settings: [{ id: 'prettier.semi', title: 'Semicolons', type: 'boolean', default: true }, { id: 'prettier.printWidth', title: 'Print width', type: 'number', default: 100 }], installs: '38.1M', versions: ['3.5.0', '3.4.1', '3.3.0'] },
  { id: 'orbitlabs.bundle-inspector', name: 'Bundle Inspector', publisher: 'Orbit Labs', version: '0.9.2', latest: '0.9.2', installed: true, enabled: true, description: 'Visualise bundle chunks, sizes and module ownership after each build.', categories: ['Visualization'], compat: '≥ 1.2.0', deps: ['oxbit.tasks-api'], permissions: ['Read build output', 'Run tasks', 'Show status bar item'], contributes: [{ kind: 'panel', name: 'Bundle Size' }, { kind: 'command', name: 'Bundle Inspector: Analyze' }, { kind: 'statusItem', name: 'bundle size' }, { kind: 'documentView', name: 'Bundle report (.bundle.json)' }], settings: [{ id: 'bundleInspector.budgetKb', title: 'Size budget (kB)', type: 'number', default: 250 }], installs: '12k', versions: ['0.9.2', '0.9.0'] },
  { id: 'oxbit.blame-lens', name: 'Blame Lens', publisher: 'Oxbit', version: '2.0.4', latest: '2.0.4', installed: true, enabled: false, description: 'Inline git blame annotations and history hover.', categories: ['SCM'], compat: '≥ 1.0.0', deps: [], permissions: ['Read git history'], contributes: [{ kind: 'decoration', name: 'Blame annotations' }, { kind: 'command', name: 'Toggle Blame' }], installs: '4.4M', versions: ['2.0.4'] },
  { id: 'tailwind.intellisense', name: 'Tailwind IntelliSense', publisher: 'Tailwind Labs', version: '0.14.2', latest: '0.14.2', installed: false, enabled: false, description: 'Class name completion, hover previews and linting for Tailwind CSS.', categories: ['Language'], compat: '≥ 1.1.0', deps: ['oxbit.css-language'], permissions: ['Read open documents'], contributes: [{ kind: 'completion', name: 'Tailwind classes' }], installs: '9.8M', versions: ['0.14.2'] },
  { id: 'community.markdown-toolkit', name: 'Markdown Toolkit', publisher: 'Community', version: '5.1.0', latest: '5.1.0', installed: false, enabled: false, description: 'Table of contents, table formatting and Mermaid preview.', categories: ['Preview'], compat: '≥ 1.0.0', deps: [], permissions: ['Read Markdown documents'], contributes: [{ kind: 'documentView', name: 'Mermaid preview' }, { kind: 'command', name: 'Insert Table of Contents' }], installs: '2.1M', versions: ['5.1.0'] },
  { id: 'rust-lang.analyzer', name: 'rust-analyzer', publisher: 'rust-lang', version: '0.4.2110', latest: '0.4.2110', installed: false, enabled: false, incompatible: 'Requires Oxbit ≥ 1.4.0 (you have 1.3.2)', description: 'Rust language support.', categories: ['Language'], compat: '≥ 1.4.0', deps: [], permissions: ['Run language server'], contributes: [{ kind: 'languageServer', name: 'rust-analyzer' }], installs: '6.2M', versions: ['0.4.2110'] },
  { id: 'docker.docker', name: 'Docker', publisher: 'Docker Inc.', version: '1.29.0', latest: '1.29.0', installed: false, enabled: false, failsInstall: true, description: 'Manage containers, images and compose files.', categories: ['Tools'], compat: '≥ 1.0.0', deps: [], permissions: ['Run shell commands', 'Network access'], contributes: [{ kind: 'panel', name: 'Containers' }, { kind: 'command', name: 'Docker: Compose Up' }], installs: '31M', versions: ['1.29.0'] },
];

export const collaborators = [
  { id: 'mira', name: 'Mira Osei', initials: 'MO', color: '#e5b567', path: 'src/hooks/useTelemetry.ts', line: 20, col: 27, status: 'editing' },
  { id: 'tomas', name: 'Tomás Rivera', initials: 'TR', color: '#b39ddb', path: 'src/components/Chart.tsx', line: 14, col: 5, status: 'viewing' },
];

export const remoteEdit = { by: 'mira', path: 'src/hooks/useTelemetry.ts', afterLine: 19, insert: '        if (cancelled) return;' };

export const commands = [
  { id: 'workbench.showCommands', title: 'Show All Commands', cat: 'View', mac: '⇧⌘P', win: 'Ctrl+Shift+P' },
  { id: 'workbench.quickOpen', title: 'Go to File…', cat: 'Go', mac: '⌘P', win: 'Ctrl+P' },
  { id: 'workbench.gotoSymbol', title: 'Go to Symbol in Editor…', cat: 'Go', mac: '⇧⌘O', win: 'Ctrl+Shift+O', when: 'editor' },
  { id: 'workbench.gotoLine', title: 'Go to Line/Column…', cat: 'Go', mac: '⌃G', win: 'Ctrl+G', when: 'editor' },
  { id: 'workbench.recent', title: 'Go to Recent…', cat: 'Go', mac: '⌘E', win: 'Ctrl+E' },
  { id: 'view.explorer', title: 'Show Explorer', cat: 'View', mac: '⇧⌘E', win: 'Ctrl+Shift+E' },
  { id: 'view.search', title: 'Search in Files', cat: 'View', mac: '⇧⌘F', win: 'Ctrl+Shift+F' },
  { id: 'view.scm', title: 'Show Source Control', cat: 'View', mac: '⌃⇧G', win: 'Ctrl+Shift+G' },
  { id: 'view.extensions', title: 'Show Extensions', cat: 'View', mac: '⇧⌘X', win: 'Ctrl+Shift+X' },
  { id: 'view.problems', title: 'Show Problems', cat: 'View', mac: '⇧⌘M', win: 'Ctrl+Shift+M' },
  { id: 'view.output', title: 'Show Output', cat: 'View', mac: '⇧⌘U', win: 'Ctrl+Shift+U' },
  { id: 'view.toggleSidebar', title: 'Toggle Sidebar', cat: 'View', mac: '⌘B', win: 'Ctrl+B' },
  { id: 'view.togglePanel', title: 'Toggle Panel', cat: 'View', mac: '⌘J', win: 'Ctrl+J' },
  { id: 'view.focusMode', title: 'Toggle Focus Mode', cat: 'View', mac: '⌘K Z', win: 'Ctrl+K Z' },
  { id: 'view.resetLayout', title: 'Reset Workspace Layout', cat: 'View' },
  { id: 'theme.toggle', title: 'Toggle Light/Dark Theme', cat: 'Preferences', mac: '⌘K ⌘T', win: 'Ctrl+K Ctrl+T' },
  { id: 'settings.open', title: 'Open Settings', cat: 'Preferences', mac: '⌘,', win: 'Ctrl+,' },
  { id: 'settings.keyboard', title: 'Open Keyboard Shortcuts', cat: 'Preferences', mac: '⌘K ⌘S', win: 'Ctrl+K Ctrl+S' },
  { id: 'file.new', title: 'New File', cat: 'File', mac: '⌘N', win: 'Ctrl+N' },
  { id: 'file.newFolder', title: 'New Folder', cat: 'File' },
  { id: 'file.save', title: 'Save', cat: 'File', mac: '⌘S', win: 'Ctrl+S', when: 'editor' },
  { id: 'file.saveAll', title: 'Save All', cat: 'File', mac: '⌥⌘S', win: 'Ctrl+K S' },
  { id: 'file.revert', title: 'Revert File', cat: 'File', when: 'editor' },
  { id: 'file.rename', title: 'Rename…', cat: 'File', mac: '↩', win: 'F2', when: 'explorer' },
  { id: 'file.delete', title: 'Delete', cat: 'File', mac: '⌘⌫', win: 'Delete', when: 'explorer' },
  { id: 'file.reveal', title: 'Reveal Active File in Explorer', cat: 'File', when: 'editor' },
  { id: 'file.copyPath', title: 'Copy Path', cat: 'File', mac: '⌥⌘C', win: 'Ctrl+Alt+C', when: 'editor' },
  { id: 'editor.closeTab', title: 'Close Editor', cat: 'View', mac: '⌘W', win: 'Ctrl+W', when: 'editor' },
  { id: 'editor.closeOthers', title: 'Close Other Editors', cat: 'View', when: 'editor' },
  { id: 'editor.pin', title: 'Pin Editor', cat: 'View', mac: '⌘K ⇧↩', win: 'Ctrl+K Shift+Enter', when: 'editor' },
  { id: 'editor.keepOpen', title: 'Keep Editor Open', cat: 'View', mac: '⌘K ↩', win: 'Ctrl+K Enter', when: 'editor' },
  { id: 'editor.splitRight', title: 'Split Editor Right', cat: 'View', mac: '⌘\\', win: 'Ctrl+\\', when: 'editor' },
  { id: 'editor.splitDown', title: 'Split Editor Down', cat: 'View', mac: '⌘K ⌘\\', win: 'Ctrl+K Ctrl+\\', when: 'editor' },
  { id: 'editor.moveToNextGroup', title: 'Move Editor into Next Group', cat: 'View', mac: '⌃⌘→', win: 'Ctrl+Alt+Right', when: 'split' },
  { id: 'editor.find', title: 'Find', cat: 'Edit', mac: '⌘F', win: 'Ctrl+F', when: 'editor' },
  { id: 'editor.replace', title: 'Replace', cat: 'Edit', mac: '⌥⌘F', win: 'Ctrl+H', when: 'editor' },
  { id: 'editor.format', title: 'Format Document', cat: 'Edit', mac: '⇧⌥F', win: 'Shift+Alt+F', when: 'formattable' },
  { id: 'editor.rename', title: 'Rename Symbol', cat: 'Edit', mac: 'F2', win: 'F2', when: 'lsp' },
  { id: 'editor.gotoDefinition', title: 'Go to Definition', cat: 'Go', mac: 'F12', win: 'F12', when: 'lsp' },
  { id: 'editor.references', title: 'Find All References', cat: 'Go', mac: '⇧F12', win: 'Shift+F12', when: 'lsp' },
  { id: 'editor.codeAction', title: 'Quick Fix…', cat: 'Edit', mac: '⌘.', win: 'Ctrl+.', when: 'lsp' },
  { id: 'editor.hover', title: 'Show Hover', cat: 'Edit', mac: '⌘K ⌘I', win: 'Ctrl+K Ctrl+I', when: 'lsp' },
  { id: 'editor.suggest', title: 'Trigger Suggest', cat: 'Edit', mac: '⌃Space', win: 'Ctrl+Space', when: 'lsp' },
  { id: 'editor.foldAll', title: 'Fold All', cat: 'Edit', mac: '⌘K ⌘0', win: 'Ctrl+K Ctrl+0', when: 'editor' },
  { id: 'editor.unfoldAll', title: 'Unfold All', cat: 'Edit', mac: '⌘K ⌘J', win: 'Ctrl+K Ctrl+J', when: 'editor' },
  { id: 'editor.toggleWordWrap', title: 'Toggle Word Wrap', cat: 'View', mac: '⌥Z', win: 'Alt+Z', when: 'editor' },
  { id: 'editor.selectAll', title: 'Select All', cat: 'Edit', mac: '⌘A', win: 'Ctrl+A', when: 'editor' },
  { id: 'terminal.new', title: 'New Terminal', cat: 'Terminal', mac: '⌃⇧`', win: 'Ctrl+Shift+`' },
  { id: 'terminal.toggle', title: 'Toggle Terminal', cat: 'Terminal', mac: '⌃`', win: 'Ctrl+`' },
  { id: 'terminal.split', title: 'Split Terminal', cat: 'Terminal', mac: '⌘\\', win: 'Ctrl+Shift+5', when: 'terminal' },
  { id: 'terminal.kill', title: 'Kill Active Terminal', cat: 'Terminal', when: 'terminal' },
  { id: 'terminal.clear', title: 'Clear Terminal', cat: 'Terminal', mac: '⌘K', win: 'Ctrl+K', when: 'terminal' },
  { id: 'tasks.run', title: 'Run Task…', cat: 'Tasks' },
  { id: 'tasks.runBuild', title: 'Run Build Task', cat: 'Tasks', mac: '⇧⌘B', win: 'Ctrl+Shift+B' },
  { id: 'tasks.rerun', title: 'Rerun Last Task', cat: 'Tasks', when: 'lastTask' },
  { id: 'tasks.cancel', title: 'Cancel Running Task', cat: 'Tasks', when: 'taskRunning' },
  { id: 'git.stageAll', title: 'Stage All Changes', cat: 'Git', when: 'gitChanges' },
  { id: 'git.unstageAll', title: 'Unstage All Changes', cat: 'Git', when: 'gitStaged' },
  { id: 'git.commit', title: 'Commit', cat: 'Git', mac: '⌘↩', win: 'Ctrl+Enter', when: 'gitStaged' },
  { id: 'git.discardAll', title: 'Discard All Changes', cat: 'Git', when: 'gitChanges' },
  { id: 'git.checkout', title: 'Checkout to…', cat: 'Git', when: 'gitRepo' },
  { id: 'git.push', title: 'Push', cat: 'Git', when: 'gitRepo' },
  { id: 'git.refresh', title: 'Refresh', cat: 'Git', when: 'gitRepo' },
  { id: 'lsp.restart', title: 'Restart Language Server', cat: 'Language', when: 'lspFile' },
  { id: 'preview.markdown', title: 'Open Preview', cat: 'Markdown', mac: '⇧⌘V', win: 'Ctrl+Shift+V', when: 'markdown' },
  { id: 'preview.markdownSide', title: 'Open Preview to the Side', cat: 'Markdown', mac: '⌘K V', win: 'Ctrl+K V', when: 'markdown' },
  { id: 'extensions.install', title: 'Install Extension…', cat: 'Extensions' },
  { id: 'extensions.checkUpdates', title: 'Check for Extension Updates', cat: 'Extensions' },
  { id: 'workspace.open', title: 'Open Folder…', cat: 'File', mac: '⌘O', win: 'Ctrl+O' },
  { id: 'workspace.switch', title: 'Switch Workspace…', cat: 'File', mac: '⌃R', win: 'Ctrl+R' },
  { id: 'workspace.close', title: 'Close Workspace', cat: 'File', mac: '⌘K F', win: 'Ctrl+K F', when: 'workspace' },
  { id: 'collab.share', title: 'Share Workspace…', cat: 'Collaboration' },
  { id: 'collab.follow', title: 'Follow Participant…', cat: 'Collaboration', when: 'collaborators' },
  { id: 'sync.reconnect', title: 'Reconnect', cat: 'Collaboration', when: 'offline' },
  { id: 'notifications.clear', title: 'Clear All Notifications', cat: 'View', when: 'notifications' },
  { id: 'bundle.analyze', title: 'Bundle Inspector: Analyze', cat: 'Bundle Inspector', when: 'bundleExt', ext: 'orbitlabs.bundle-inspector' },
  { id: 'help.about', title: 'About Oxbit', cat: 'Help' },
];

export const menus = {
  File: ['file.new', 'file.newFolder', 'workspace.open', 'workspace.switch', '-', 'file.save', 'file.saveAll', 'file.revert', '-', 'editor.closeTab', 'workspace.close'],
  Edit: ['editor.find', 'editor.replace', '-', 'editor.selectAll', 'editor.toggleWordWrap', '-', 'editor.format', 'editor.rename', 'editor.codeAction'],
  View: ['workbench.showCommands', '-', 'view.explorer', 'view.search', 'view.scm', 'view.extensions', 'view.problems', 'view.output', '-', 'view.toggleSidebar', 'view.togglePanel', 'view.focusMode', 'view.resetLayout', '-', 'theme.toggle'],
  Go: ['workbench.quickOpen', 'workbench.gotoSymbol', 'workbench.gotoLine', 'workbench.recent', '-', 'editor.gotoDefinition', 'editor.references'],
  Terminal: ['terminal.new', 'terminal.split', 'terminal.toggle', 'terminal.kill', '-', 'tasks.run', 'tasks.runBuild', 'tasks.rerun', 'tasks.cancel'],
  Help: ['settings.keyboard', 'help.about'],
};

export const settingsSchema = [
  { id: 'workbench.colorTheme', cat: 'Appearance', title: 'Color Theme', desc: 'Specifies the color theme used in the workbench.', type: 'enum', options: ['Graphite (dark)', 'Paper (light)'], default: 'Graphite (dark)' },
  { id: 'workbench.density', cat: 'Appearance', title: 'Layout Density', desc: 'Controls row heights, padding and label sizes across the workbench.', type: 'enum', options: ['compact', 'comfortable'], default: 'compact' },
  { id: 'workbench.sidebarLocation', cat: 'Appearance', title: 'Sidebar Location', desc: 'Where the primary sidebar is docked.', type: 'enum', options: ['left', 'right'], default: 'left' },
  { id: 'editor.fontFamily', cat: 'Editor · Typography', title: 'Font Family', desc: 'Controls the font family of the editor.', type: 'string', default: "'JetBrains Mono', ui-monospace, monospace" },
  { id: 'editor.fontSize', cat: 'Editor · Typography', title: 'Font Size', desc: 'Font size in pixels.', type: 'number', default: 13, min: 8, max: 32 },
  { id: 'editor.lineHeight', cat: 'Editor · Typography', title: 'Line Height', desc: 'Line height in pixels. 0 uses 1.55 × font size.', type: 'number', default: 20, min: 0, max: 60 },
  { id: 'editor.fontLigatures', cat: 'Editor · Typography', title: 'Font Ligatures', desc: 'Enables font ligatures when the font supports them.', type: 'boolean', default: false },
  { id: 'editor.tabSize', cat: 'Editor · Indentation', title: 'Tab Size', desc: 'The number of spaces a tab is equal to.', type: 'number', default: 2, min: 1, max: 8 },
  { id: 'editor.insertSpaces', cat: 'Editor · Indentation', title: 'Insert Spaces', desc: 'Insert spaces when pressing Tab.', type: 'boolean', default: true },
  { id: 'editor.detectIndentation', cat: 'Editor · Indentation', title: 'Detect Indentation', desc: 'Detect Tab Size and Insert Spaces from file contents on open.', type: 'boolean', default: true },
  { id: 'editor.renderIndentGuides', cat: 'Editor · Indentation', title: 'Indentation Guides', desc: 'Render vertical guides for each indent level.', type: 'boolean', default: true },
  { id: 'editor.wordWrap', cat: 'Editor', title: 'Word Wrap', desc: 'Controls how lines should wrap.', type: 'enum', options: ['off', 'on', 'bounded'], default: 'off' },
  { id: 'editor.renderWhitespace', cat: 'Editor', title: 'Render Whitespace', desc: 'Controls how the editor renders whitespace characters.', type: 'enum', options: ['none', 'boundary', 'selection', 'all'], default: 'selection' },
  { id: 'editor.cursorBlinking', cat: 'Editor', title: 'Cursor Blinking', desc: 'Cursor animation style.', type: 'enum', options: ['blink', 'smooth', 'phase', 'solid'], default: 'blink' },
  { id: 'editor.minimap', cat: 'Editor', title: 'Minimap', desc: 'Show a minimap of the document.', type: 'boolean', default: false },
  { id: 'files.autoSave', cat: 'Files', title: 'Auto Save', desc: 'Controls auto save of editors that have unsaved changes.', type: 'enum', options: ['off', 'afterDelay', 'onFocusChange', 'onWindowChange'], default: 'off' },
  { id: 'files.autoSaveDelay', cat: 'Files', title: 'Auto Save Delay', desc: 'Delay in milliseconds after which an editor is saved automatically. Applies when Auto Save is afterDelay.', type: 'number', default: 1000, min: 100, max: 60000 },
  { id: 'files.trimTrailingWhitespace', cat: 'Files', title: 'Trim Trailing Whitespace', desc: 'Remove trailing whitespace when saving.', type: 'boolean', default: true },
  { id: 'editor.formatOnSave', cat: 'Formatting', title: 'Format On Save', desc: 'Format a file on save. A formatter must be available.', type: 'boolean', default: false },
  { id: 'editor.defaultFormatter', cat: 'Formatting', title: 'Default Formatter', desc: 'Formatter used when several are available.', type: 'enum', options: ['oxbit.prettier', 'oxbit.builtin-ts'], default: 'oxbit.prettier' },
  { id: 'terminal.fontSize', cat: 'Terminal', title: 'Terminal Font Size', desc: 'Font size in pixels for the terminal.', type: 'number', default: 12, min: 8, max: 32 },
  { id: 'terminal.scrollback', cat: 'Terminal', title: 'Scrollback', desc: 'Maximum number of lines kept in the terminal buffer.', type: 'number', default: 5000, min: 100, max: 100000 },
  { id: 'terminal.confirmOnKill', cat: 'Terminal', title: 'Confirm On Kill', desc: 'Ask before killing a terminal with a running process.', type: 'boolean', default: true },
  { id: 'scm.autoFetch', cat: 'Source Control', title: 'Auto Fetch', desc: 'Periodically fetch from the default remote.', type: 'boolean', default: true },
  { id: 'scm.diffLayout', cat: 'Source Control', title: 'Diff Layout', desc: 'Default layout for diff editors.', type: 'enum', options: ['side-by-side', 'inline'], default: 'side-by-side' },
];

export const workspaceSettingOverrides = { 'editor.tabSize': 2, 'editor.formatOnSave': true, 'files.trimTrailingWhitespace': true };
export const userSettingOverrides = { 'editor.fontSize': 13, 'workbench.density': 'compact' };

// User keybinding overrides; the second one conflicts with workbench.quickOpen
export const userKeybindings = [
  { command: 'view.togglePanel', mac: '⌘J', win: 'Ctrl+J', source: 'default' },
  { command: 'workbench.gotoSymbol', mac: '⌘P', win: 'Ctrl+P', source: 'user' },
];

export const notificationsSeed = [
  { id: 'n1', kind: 'info', title: 'Prettier 3.5.0 is available', body: 'Restart is not required.', actions: ['Update', 'Later'], time: '12:04' },
  { id: 'n2', kind: 'warning', title: "'src/lib/format.ts' changed on disk", body: 'The file has unsaved local edits. Compare before reloading.', actions: ['Compare', 'Reload', 'Keep mine'], time: '12:06' },
];

export const strings = {
  en: {
    explorer: 'Explorer', search: 'Search', scm: 'Source Control', extensions: 'Extensions', settings: 'Settings', problems: 'Problems', terminal: 'Terminal', output: 'Output', tasks: 'Tasks',
    openEditors: 'Open Editors', outline: 'Outline', stagedChanges: 'Staged Changes', changes: 'Changes', mergeConflicts: 'Merge Conflicts', commit: 'Commit', stageAll: 'Stage All', unstageAll: 'Unstage All', discardAll: 'Discard All Changes',
    installed: 'Installed', available: 'Available', install: 'Install', uninstall: 'Uninstall', enable: 'Enable', disable: 'Disable', update: 'Update', retry: 'Retry',
    replace: 'Replace', replaceAll: 'Replace All', filesToInclude: 'files to include', filesToExclude: 'files to exclude', noResults: 'No results found.', searching: 'Searching…', cancel: 'Cancel',
    save: 'Save', dontSave: "Don't Save", delete: 'Delete', rename: 'Rename', newFile: 'New File', newFolder: 'New Folder', keyboardShortcuts: 'Keyboard Shortcuts', user: 'User', workspace: 'Workspace', reset: 'Reset to default', modifiedInUser: 'Modified in User', modifiedInWorkspace: 'Modified in Workspace',
    recent: 'Recent projects', openFolder: 'Open Folder…', cloneRepo: 'Clone Repository…', noWorkspace: 'No workspace open', focusMode: 'Focus mode', exitFocus: 'Exit focus mode (Esc Esc)',
  },
  long: {
    explorer: 'Datei-Explorer', search: 'Suchen und Ersetzen', scm: 'Quellcodeverwaltung', extensions: 'Erweiterungen', settings: 'Einstellungen', problems: 'Probleme und Warnungen', terminal: 'Terminal', output: 'Ausgabe', tasks: 'Aufgaben',
    openEditors: 'Geöffnete Editoren', outline: 'Gliederung', stagedChanges: 'Bereitgestellte Änderungen', changes: 'Änderungen', mergeConflicts: 'Zusammenführungskonflikte', commit: 'Änderungen committen', stageAll: 'Alle Änderungen bereitstellen', unstageAll: 'Bereitstellung aufheben', discardAll: 'Alle Änderungen verwerfen',
    installed: 'Installiert', available: 'Verfügbar', install: 'Installieren', uninstall: 'Deinstallieren', enable: 'Aktivieren', disable: 'Deaktivieren', update: 'Aktualisieren', retry: 'Erneut versuchen',
    replace: 'Ersetzen', replaceAll: 'Alle ersetzen', filesToInclude: 'einzuschließende Dateien', filesToExclude: 'auszuschließende Dateien', noResults: 'Keine Ergebnisse gefunden.', searching: 'Suche läuft…', cancel: 'Abbrechen',
    save: 'Speichern', dontSave: 'Nicht speichern', delete: 'Löschen', rename: 'Umbenennen', newFile: 'Neue Datei', newFolder: 'Neuer Ordner', keyboardShortcuts: 'Tastenkombinationen', user: 'Benutzer', workspace: 'Arbeitsbereich', reset: 'Auf Standard zurücksetzen', modifiedInUser: 'In Benutzereinstellungen geändert', modifiedInWorkspace: 'Im Arbeitsbereich geändert',
    recent: 'Zuletzt verwendete Projekte', openFolder: 'Ordner öffnen…', cloneRepo: 'Repository klonen…', noWorkspace: 'Kein Arbeitsbereich geöffnet', focusMode: 'Fokusmodus', exitFocus: 'Fokusmodus verlassen (Esc Esc)',
  },
};

export const langMeta = {
  ts: { label: 'TypeScript', badge: 'TS', color: '#82b1ff', lsp: true, formattable: true },
  tsx: { label: 'TypeScript JSX', badge: 'TX', color: '#82b1ff', lsp: true, formattable: true },
  js: { label: 'JavaScript', badge: 'JS', color: '#f2b571', lsp: true, formattable: true },
  json: { label: 'JSON', badge: '{}', color: '#e5b567', lsp: true, formattable: true },
  css: { label: 'CSS', badge: '#', color: '#b39ddb', lsp: true, formattable: true },
  html: { label: 'HTML', badge: '<>', color: '#f28b82', lsp: false, formattable: true },
  md: { label: 'Markdown', badge: 'M↓', color: '#8bd5ca', lsp: false, formattable: true },
  txt: { label: 'Plain Text', badge: '≡', color: '#9aa1ad', lsp: false, formattable: false },
};
