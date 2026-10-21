import { readFileSync } from 'node:fs';
import path from 'node:path';
import { tryRun } from './exec.mjs';

export const TERMINAL_ROUTE =
  'Write the commands to /tmp/task.command with `#!/bin/zsh -l` and a sentinel line at the end, `chmod +x` it, ' +
  'run `open -a Terminal /tmp/task.command`, and poll its log. That script runs in the Aqua session with the unlocked keychain.';

function readText(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

export function compareVersions(expected, actual) {
  if (!expected || !actual) return { expected, actual, match: false, majorMatch: false };
  return { expected, actual, match: expected === actual, majorMatch: expected.split('.')[0] === actual.split('.')[0] };
}

function session(env, platform) {
  if (platform !== 'darwin') return { manager: null, background: false, note: 'launchctl managername applies to macOS only' };
  const result = tryRun('launchctl', ['managername'], { env, timeoutMs: 3000 });
  if (!result.ok) return { manager: null, background: false, error: result.error };
  const background = result.stdout === 'Background';
  return {
    manager: result.stdout,
    background,
    note: background
      ? 'Background session: codesign, gh tokens in the keychain, git push over HTTPS through the osxkeychain helper, SSH keys with a ' +
        `keychain passphrase, and GPG commit signing fail here. ${TERMINAL_ROUTE}`
      : 'Aqua session: the login keychain is reachable.',
  };
}

function toolVersion(command, env) {
  const result = tryRun(command, ['--version'], { env, timeoutMs: 5000 });
  return result.ok ? result.stdout.replace(/^v/, '') : null;
}

export function doctor({ root, env, platform = process.platform }) {
  const nodeExpected = readText(path.join(root, '.node-version'))?.trim().replace(/^v/, '') ?? null;
  let bunExpected = null;
  try {
    bunExpected = /^bun@(.+)$/.exec(JSON.parse(readText(path.join(root, 'package.json')) ?? '{}').packageManager ?? '')?.[1] ?? null;
  } catch {
    bunExpected = null;
  }
  const node = { ...compareVersions(nodeExpected, toolVersion('node', env)), source: '.node-version', server: process.versions.node };
  const bun = { ...compareVersions(bunExpected, toolVersion('bun', env)), source: 'package.json packageManager' };
  const sessionInfo = session(env, platform);
  const problems = [];
  if (sessionInfo.background) problems.push('Background security session');
  if (!node.majorMatch) problems.push(`node ${node.actual ?? 'missing'} is outside the ${nodeExpected} major line`);
  else if (!node.match) problems.push(`node ${node.actual} differs from .node-version ${nodeExpected}`);
  if (!bun.match) problems.push(`bun ${bun.actual ?? 'missing'} differs from packageManager bun@${bunExpected}`);
  return { session: sessionInfo, node, bun, problems };
}

export const doctorTool = {
  definition: {
    name: 'doctor',
    title: 'Agent shell doctor',
    description:
      'Report the macOS security session (`launchctl managername`; Background breaks keychain, codesign, gh, git push and GPG signing, ' +
      'with the Terminal .command route to use instead), node against .node-version, and bun against package.json packageManager.',
    inputSchema: { type: 'object', additionalProperties: false },
  },
  run: (_args, ctx) => doctor({ root: ctx.root, env: ctx.env, platform: ctx.platform }),
};
