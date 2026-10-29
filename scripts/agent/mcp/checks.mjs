import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathsSchema, resolvePaths } from './paths.mjs';
import { globToRegExp, loadWorkflows, runsOnPullRequest, runsOnThisHost } from './workflows.mjs';

const CODE = /^(?:apps|packages|examples|tests|scripts)\/.*\.[cm]?[jt]sx?$/;
const TYPED = /\.(?:[cm]?tsx?)$|(?:^|\/)tsconfig[^/]*\.json$/;
const THEMED = /^(?:packages\/(?:ui\/src|workbench\/src|features)|apps\/(?:web|desktop)\/src)\/.*\.(?:tsx?|css)$/;
const SETUP = /^(?:sudo |brew |rustup |bun install\b|bunx playwright install\b|echo .*GITHUB_ENV)/;

// Narrows the jobs desktop.yml and ios.yml run on every PR to the paths that need them.
export const EVERY_PR_CHECKS = [
  { id: 'lint', match: (p) => CODE.test(p) || p.startsWith('eslint.config'), command: 'bun run lint', ciCommand: 'bun run lint', why: 'ESLint over apps, packages, examples, tests and scripts' },
  { id: 'typecheck', match: (p) => TYPED.test(p), command: 'bun run typecheck', ciCommand: 'bun run typecheck', why: 'tsc -b over the workspace' },
  { id: 'unit', match: (p) => CODE.test(p) || p === 'vitest.config.ts', command: 'bun run test', ciCommand: 'bun run test', why: 'vitest over packages, apps and tests' },
  {
    id: 'theme-coverage',
    match: (p) => THEMED.test(p) || p.startsWith('packages/themes/') || p === 'scripts/theme-coverage.mjs' || p === 'docs/theme-coverage.md',
    command: 'node scripts/theme-coverage.mjs --check',
    ciCommand: 'bun run test',
    why: 'packages/themes/src/index.test.ts runs it inside `bun run test`; raw colors and px font sizes fail it (PR #103)',
  },
  {
    id: 'desktop-rust',
    match: (p) => p.startsWith('apps/desktop/src-tauri/'),
    command: 'bun run desktop:check',
    ciCommand: 'bun run desktop:check',
    why: 'cargo fmt --check, clippy -D warnings and cargo test; CI also runs it on Linux, where cfg-gated code differs (PR #93)',
  },
  { id: 'ios-rust', match: (p) => p.startsWith('apps/ios/'), command: 'bun run ios:check', ciCommand: 'bun run ios:check', why: 'iOS frontend build, language server notices, cargo fmt, clippy -D warnings and cargo test' },
  {
    id: 'browser',
    match: (p) => /^(?:apps\/web|packages)\/.*\.(?:tsx|css)$/.test(p) || p.startsWith('tests/browser/'),
    command: 'bun run build && bun run test:browser',
    ciCommand: 'bun run test:browser',
    why: 'Playwright journeys against the built web app',
  },
  { id: 'lockfile', match: (p) => p === 'bun.lock' || /(?:^|\/)package\.json$/.test(p), command: 'bun install --frozen-lockfile', ciCommand: 'bun install --frozen-lockfile', why: 'CI installs with a frozen lockfile' },
];

function commandLines(run) {
  return run.split('\n').map((line) => line.trim()).filter(Boolean);
}

function readScripts(root) {
  try {
    return JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).scripts ?? {};
  } catch {
    return {};
  }
}

function withScript(scripts, entry) {
  const match = /^bun run ([\w:.-]+)/.exec(entry.command);
  return match && scripts[match[1]] ? { ...entry, script: scripts[match[1]] } : entry;
}

export function checksForPaths(root, paths, { platform = process.platform } = {}) {
  const scripts = readScripts(root);
  const workflows = [];
  const skipped = [];
  const focused = new Map();
  const ciLines = [];
  for (const workflow of loadWorkflows(root)) {
    if (!workflow.pullRequest) continue;
    const filters = workflow.paths?.map(globToRegExp);
    const matchedPaths = filters ? paths.filter((p) => filters.some((filter) => filter.test(p))) : paths;
    const commands = [];
    for (const job of workflow.jobs.filter(runsOnPullRequest)) {
      for (const step of job.steps) {
        if (!step.run) continue;
        ciLines.push(...commandLines(step.run));
        if (SETUP.test(step.run) || !runsOnThisHost(step, platform)) continue;
        commands.push({ job: job.id, step: step.name, command: step.run });
      }
    }
    if (filters && matchedPaths.length === 0) {
      skipped.push({ file: workflow.file, reason: 'no path matches its pull_request.paths filter' });
      continue;
    }
    workflows.push({ file: workflow.file, trigger: filters ? 'paths filter' : 'every PR', matchedPaths, commands });
    if (!filters) continue;
    for (const entry of commands) {
      if (!focused.has(entry.command)) {
        focused.set(entry.command, { command: entry.command, why: `${workflow.file} job ${entry.job}`, paths: matchedPaths });
      }
    }
  }
  const drift = [];
  for (const check of EVERY_PR_CHECKS) {
    const ran = ciLines.some((line) => line === check.ciCommand || line.startsWith(`${check.ciCommand} `));
    if (!ran) {
      drift.push({ id: check.id, ciCommand: check.ciCommand, reason: 'no PR workflow runs this command any more' });
      continue;
    }
    const matched = paths.filter(check.match);
    if (matched.length && !focused.has(check.command)) {
      focused.set(check.command, { command: check.command, why: check.why, paths: matched });
    }
  }
  return { focused: [...focused.values()].map((entry) => withScript(scripts, entry)), workflows, skipped, drift };
}

export const checksForPathsTool = {
  definition: {
    name: 'checks_for_paths',
    title: 'Local checks for changed paths',
    description:
      'Return the local commands the PR workflows in .github/workflows and package.json scripts run for the given paths. ' +
      '`focused` lists the commands to run before pushing; `workflows` lists every run step of each PR workflow that triggers.',
    inputSchema: { type: 'object', properties: { paths: pathsSchema }, additionalProperties: false },
  },
  run(args, ctx) {
    const { base, paths } = resolvePaths(ctx.root, ctx.env, args.paths);
    return { base, paths, ...checksForPaths(ctx.root, paths, { platform: ctx.platform }) };
  },
};
