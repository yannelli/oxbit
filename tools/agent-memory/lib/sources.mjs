import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, join, sep } from 'node:path';
import { expandPath } from './config.mjs';

const SECTION_SPLIT_CHARS = 3000;
const SECTION_MAX_CHARS = 6000;

function segmentRegex(segment) {
  const escaped = segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
  return new RegExp(`^${escaped}$`);
}

function safeReaddir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function isDirectory(entry, dir) {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return statSync(join(dir, entry.name)).isDirectory();
  } catch {
    return false;
  }
}

function walkGlob(dir, segments, exclude, out) {
  if (segments.length === 0) return;
  const [head, ...rest] = segments;
  if (head === '**') {
    walkGlob(dir, rest, exclude, out);
    for (const entry of safeReaddir(dir)) {
      if (exclude.has(entry.name) || !isDirectory(entry, dir)) continue;
      walkGlob(join(dir, entry.name), segments, exclude, out);
    }
    return;
  }
  const pattern = segmentRegex(head);
  for (const entry of safeReaddir(dir)) {
    if (exclude.has(entry.name) || !pattern.test(entry.name)) continue;
    const path = join(dir, entry.name);
    if (rest.length > 0) {
      if (isDirectory(entry, dir)) walkGlob(path, rest, exclude, out);
    } else if (!isDirectory(entry, dir)) {
      out.push(path);
    }
  }
}

export function expandGlob(pattern, exclude = []) {
  const parts = pattern.split(sep);
  const firstGlob = parts.findIndex((part) => /[*?]/.test(part));
  if (firstGlob === -1) return [pattern];
  const out = [];
  walkGlob(parts.slice(0, firstGlob).join(sep) || sep, parts.slice(firstGlob), new Set(exclude), out);
  return out;
}

/** Lists source files with mtime and size in source order, deduped by realpath. */
export function listSourceFiles(config, { repo, env = process.env } = {}) {
  const seen = new Map();
  for (const source of config.sources) {
    const pattern = expandPath(source, { repo, env });
    if (!pattern) continue;
    for (const path of expandGlob(pattern, config.exclude).sort()) {
      let real;
      try {
        real = realpathSync(path);
      } catch {
        continue;
      }
      if (seen.has(real)) continue;
      try {
        const stat = statSync(real);
        seen.set(real, { path: real, mtimeMs: Math.floor(stat.mtimeMs), size: stat.size });
      } catch {
        continue;
      }
    }
  }
  return [...seen.values()];
}

function parseFrontmatter(text) {
  if (!text.startsWith('---\n')) return { meta: {}, body: text, bodyLine: 1 };
  const end = text.indexOf('\n---', 4);
  if (end === -1) return { meta: {}, body: text, bodyLine: 1 };
  const meta = {};
  for (const line of text.slice(4, end).split('\n')) {
    const match = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (match && match[2]) meta[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
  const bodyStart = text.indexOf('\n', end + 4) + 1;
  return { meta, body: text.slice(bodyStart), bodyLine: text.slice(0, bodyStart).split('\n').length };
}

function firstSentence(text) {
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('|') || line.startsWith('```') || /^created:/i.test(line)) continue;
    return line.replace(/^[-*]\s+/, '').slice(0, 160);
  }
  return '';
}

function hashText(path, text) {
  return createHash('sha1').update(path).update('\0').update(text).digest('hex').slice(0, 16);
}

function digest(text) {
  return createHash('sha1').update(text.trim()).digest('hex').slice(0, 16);
}

function splitSections(body, bodyLine) {
  const lines = body.split('\n');
  const sections = [];
  let current = { heading: '', line: bodyLine, lines: [] };
  for (let index = 0; index < lines.length; index += 1) {
    const heading = /^#{2,3}\s+(.+)$/.exec(lines[index]);
    if (heading && current.lines.length > 0) {
      sections.push(current);
      current = { heading: heading[1].trim(), line: bodyLine + index, lines: [] };
    } else if (heading) {
      current.heading = heading[1].trim();
    }
    current.lines.push(lines[index]);
  }
  sections.push(current);
  return sections.filter((section) => section.lines.join('').trim().length > 0);
}

/** Splits one Markdown file into chunks; files over 3,000 characters split at `##` and `###` headings. */
export function chunkFile(path, text) {
  const { meta, body, bodyLine } = parseFrontmatter(text);
  const heading = /^#\s+(.+)$/m.exec(body);
  const fileTitle = meta.name || heading?.[1]?.trim() || basename(path, '.md');
  const description = meta.description || firstSentence(body);
  if (text.length <= SECTION_SPLIT_CHARS) {
    return [{ id: path, path, line: 1, title: fileTitle, description, text: body, hash: hashText(path, text), digest: digest(body) }];
  }
  return splitSections(body, bodyLine).map((section) => {
    const sectionText = section.lines.join('\n').slice(0, SECTION_MAX_CHARS);
    const title = section.heading ? `${fileTitle} / ${section.heading}` : fileTitle;
    return {
      id: `${path}:${section.line}`,
      path,
      line: section.line,
      title,
      description: section.heading ? firstSentence(sectionText) : description,
      text: sectionText,
      hash: hashText(`${path}:${section.line}`, sectionText),
      digest: digest(sectionText),
    };
  });
}

export function readChunks(file) {
  try {
    return chunkFile(file.path, readFileSync(file.path, 'utf8'));
  } catch {
    return [];
  }
}
