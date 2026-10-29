import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export function globToRegExp(glob) {
  let source = '';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === '*' && glob[index + 1] === '*') {
      const slash = glob[index + 2] === '/';
      source += slash ? '(?:.*/)?' : '.*';
      index += slash ? 2 : 1;
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

function unquote(value) {
  const trimmed = value.trim();
  return /^(['"]).*\1$/.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
}

function indentOf(line) {
  return line.length - line.trimStart().length;
}

function splitKey(text) {
  const match = /^([\w.-]+):(?:\s+(.*))?$/.exec(text);
  return match ? { key: match[1], value: match[2] ?? '' } : null;
}

function readBlock(lines, start, keyIndent) {
  const body = [];
  let index = start + 1;
  for (; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() && indentOf(line) <= keyIndent) break;
    body.push(line);
  }
  const strip = Math.min(...body.filter((line) => line.trim()).map(indentOf));
  return { text: body.map((line) => line.slice(strip)).join('\n').trim(), end: index - 1 };
}

// Reads the subset of GitHub Actions YAML the repo uses: `on.pull_request.paths`, job `if`, step `name`/`if`/`run`.
export function parseWorkflow(file, source) {
  const workflow = { file, pullRequest: false, paths: null, jobs: [] };
  const lines = source.split('\n');
  let section = null;
  let event = null;
  let inPaths = false;
  let jobIndent = null;
  let job = null;
  let step = null;
  let stepIndent = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const text = line.trim();
    if (!text || text.startsWith('#')) continue;
    const indent = indentOf(line);
    if (indent === 0) {
      const entry = splitKey(text);
      section = entry?.key ?? null;
      if (section === 'on' && /pull_request/.test(entry.value)) workflow.pullRequest = true;
      continue;
    }
    if (section === 'on') {
      if (indent === 2) {
        event = splitKey(text.replace(/^- /, ''))?.key ?? unquote(text.replace(/^- /, ''));
        inPaths = false;
        if (event === 'pull_request') workflow.pullRequest = true;
      } else if (event === 'pull_request' && indent === 4) {
        inPaths = splitKey(text)?.key === 'paths';
        if (inPaths) workflow.paths = [];
      } else if (inPaths && text.startsWith('- ')) workflow.paths.push(unquote(text.slice(2)));
      continue;
    }
    if (section !== 'jobs') continue;
    jobIndent ??= indent;
    if (indent === jobIndent) {
      job = { id: splitKey(text)?.key ?? text, if: null, steps: [] };
      workflow.jobs.push(job);
      step = null;
      stepIndent = null;
      continue;
    }
    if (!job) continue;
    const listItem = text.startsWith('- ');
    const entry = splitKey(listItem ? text.slice(2) : text);
    if (indent === jobIndent + 2) {
      if (entry?.key === 'if') job.if = unquote(entry.value);
      stepIndent = entry?.key === 'steps' ? -1 : null;
      step = null;
      continue;
    }
    if (stepIndent === null) continue;
    if (listItem && (stepIndent === -1 || indent === stepIndent)) {
      stepIndent = indent;
      step = { name: null, if: null, run: null };
      job.steps.push(step);
    }
    const keyIndent = listItem ? indent + 2 : indent;
    if (!step || !entry || keyIndent !== stepIndent + 2) continue;
    if (entry.key === 'name' || entry.key === 'if') step[entry.key] = unquote(entry.value);
    if (entry.key === 'run') {
      if (/^[|>][-+]?$/.test(entry.value)) {
        const block = readBlock(lines, index, keyIndent);
        step.run = block.text;
        index = block.end;
      } else step.run = unquote(entry.value);
    }
  }
  return workflow;
}

export function loadWorkflows(root) {
  const dir = path.join(root, '.github', 'workflows');
  let files = [];
  try {
    files = readdirSync(dir).filter((name) => /\.ya?ml$/.test(name)).sort();
  } catch {
    return [];
  }
  return files.map((name) => parseWorkflow(`.github/workflows/${name}`, readFileSync(path.join(dir, name), 'utf8')));
}

export function runsOnPullRequest(job) {
  return !job.if || !/!=\s*'pull_request'/.test(job.if);
}

const RUNNER_OS = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' };

export function runsOnThisHost(step, platform = process.platform) {
  const match = /runner\.os\s*==\s*'(\w+)'/.exec(step.if ?? '');
  return !match || match[1] === RUNNER_OS[platform];
}
