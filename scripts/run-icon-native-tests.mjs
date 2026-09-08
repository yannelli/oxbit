import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
const fixture = await mkdtemp(path.join(os.tmpdir(), 'Oxbit icon restart '));
try {
  for (const name of ['Alpha project', 'Beta 项目']) {
    const project = path.join(fixture, name); await mkdir(path.join(project, 'src'), { recursive: true });
    await writeFile(path.join(project, 'hello.ts'), 'export const greeting = "hello";\n');
    await writeFile(path.join(project, 'src/nested.ts'), 'export const nested = 1;\n');
    execFileSync('git', ['init', '-q', project]);
  }
  const env = { ...process.env, OXBIT_NATIVE_FIXTURES: fixture, OXBIT_ICON_KEEP: '1' };
  // Two separate driver/application launches prove disk persistence across process restart.
  execFileSync('pnpm', ['exec', 'wdio', 'run', 'tests/desktop/icon-packs.conf.mjs'], { env, stdio: 'inherit' });
  execFileSync('pnpm', ['exec', 'wdio', 'run', 'tests/desktop/icon-packs.conf.mjs'], { env: { ...env, OXBIT_ICON_RESTART: '1' }, stdio: 'inherit' });
} finally { await rm(fixture, { recursive: true, force: true }); }
