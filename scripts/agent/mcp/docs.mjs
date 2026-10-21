import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathsSchema, resolvePaths } from './paths.mjs';

const SKIP_DIRS = new Set(['agents/ledgers']);
const MANIFESTS = ['package.json', 'Cargo.toml'];
const RANK = { path: 0, index: 1, package: 2 };

export function parseIndex(source) {
  const rows = [];
  for (const line of source.split('\n')) {
    const match = /^\|\s*\[([^\]]+)\]\(([^)#]+)(?:#[^)]*)?\)\s*\|\s*(.*?)\s*\|\s*$/.exec(line);
    if (match) rows.push({ title: match[1], doc: `docs/${match[2]}`, useWhen: match[3] });
  }
  return rows;
}

function markdownFiles(root, dir = 'docs') {
  const files = [];
  let entries = [];
  try {
    entries = readdirSync(path.join(root, dir), { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const relative = `${dir}/${entry.name}`;
    if (entry.isDirectory() && !SKIP_DIRS.has(relative.slice(5))) files.push(...markdownFiles(root, relative));
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(relative);
  }
  return files.sort();
}

export function packageDir(root, file) {
  let dir = path.posix.dirname(file);
  while (dir && dir !== '.') {
    if (MANIFESTS.some((name) => existsSync(path.join(root, dir, name)))) return dir;
    dir = path.posix.dirname(dir);
  }
  return null;
}

function mentions(text, needle) {
  let from = 0;
  while (true) {
    const at = text.indexOf(needle, from);
    if (at === -1) return false;
    const before = text[at - 1];
    const after = text[at + needle.length];
    if ((!before || !/[\w-]/.test(before)) && (!after || !/[\w-]/.test(after))) return true;
    from = at + 1;
  }
}

export function docsForPaths(root, paths) {
  const indexSource = existsSync(path.join(root, 'docs/INDEX.md')) ? readFileSync(path.join(root, 'docs/INDEX.md'), 'utf8') : '';
  const index = parseIndex(indexSource);
  const titles = new Map(index.map((row) => [row.doc, row.title]));
  const docs = markdownFiles(root).filter((doc) => doc !== 'docs/INDEX.md').map((doc) => ({ doc, lines: readFileSync(path.join(root, doc), 'utf8').split('\n') }));
  return paths.map((file) => {
    const pkg = packageDir(root, file);
    const found = new Map();
    const add = (doc, via, line) => {
      const entry = found.get(doc) ?? { doc, title: titles.get(doc) ?? null, via, lines: [] };
      if (RANK[via] < RANK[entry.via]) entry.via = via;
      if (line && entry.lines.length < 5) entry.lines.push(line);
      found.set(doc, entry);
    };
    for (const row of index) {
      if (row.doc === file || mentions(row.useWhen, file) || (pkg && mentions(row.useWhen, pkg))) add(row.doc, 'index');
    }
    for (const { doc, lines } of docs) {
      lines.forEach((text, at) => {
        if (mentions(text, file)) add(doc, 'path', at + 1);
        else if (pkg && mentions(text, pkg)) add(doc, 'package', at + 1);
      });
    }
    const sorted = [...found.values()].sort((a, b) => RANK[a.via] - RANK[b.via] || b.lines.length - a.lines.length || a.doc.localeCompare(b.doc));
    return { path: file, package: pkg, docs: sorted };
  });
}

export const docsForPathsTool = {
  definition: {
    name: 'docs_for_paths',
    title: 'Docs that cover paths',
    description:
      'Return the docs that cover each path: docs/INDEX.md rows and docs under docs/ that mention the path or its package directory, ' +
      'with line numbers. Use it to update docs in the same change as the code.',
    inputSchema: { type: 'object', properties: { paths: pathsSchema }, additionalProperties: false },
  },
  run(args, ctx) {
    const { base, paths } = resolvePaths(ctx.root, ctx.env, args.paths);
    return { base, results: docsForPaths(ctx.root, paths) };
  },
};
