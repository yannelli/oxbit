// Language utilities: tokenizer, decorations, diff, markdown, fuzzy. Pure functions, no UI.
const KW = new Set('import export from default const let var function return if else for while do switch case break continue new class extends interface type enum implements as async await try catch finally throw typeof instanceof in of void null undefined true false this super readonly keyof declare namespace module abstract static public private protected get set yield delete satisfies'.split(' '));
const TS_TYPES = new Set('string number boolean unknown any never object symbol bigint Promise Record Partial Readonly Array Map Set Date Error JSX HTMLCanvasElement HTMLButtonElement ButtonHTMLAttributes ReactNode Dispatch SetStateAction EffectCallback DependencyList TimerHandler'.split(' '));

function pushTok(out, kind, text) { if (text) out.push({ kind, text }); }

export function tokenizeLine(line, lang, state) {
  const out = [];
  let i = 0; const n = line.length;
  if (lang === 'md') return tokenizeMd(line, state);
  if (lang === 'txt') return [{ kind: 'text', text: line }];
  if (lang === 'json') return tokenizeJson(line);
  if (lang === 'css') return tokenizeCss(line, state);
  if (lang === 'html') return tokenizeHtml(line, state);
  // ts / tsx / js
  if (state.inBlock) {
    const end = line.indexOf('*/');
    if (end === -1) return [{ kind: 'comment', text: line }];
    pushTok(out, 'comment', line.slice(0, end + 2)); i = end + 2; state.inBlock = false;
  }
  if (state.inTemplate) {
    const end = line.indexOf('`');
    if (end === -1) return out.concat([{ kind: 'string', text: line.slice(i) }]);
    pushTok(out, 'string', line.slice(i, end + 1)); i = end + 1; state.inTemplate = false;
  }
  while (i < n) {
    const ch = line[i];
    if (ch === '/' && line[i + 1] === '/') { pushTok(out, 'comment', line.slice(i)); break; }
    if (ch === '/' && line[i + 1] === '*') {
      const end = line.indexOf('*/', i + 2);
      if (end === -1) { pushTok(out, 'comment', line.slice(i)); state.inBlock = true; break; }
      pushTok(out, 'comment', line.slice(i, end + 2)); i = end + 2; continue;
    }
    if (ch === '`') {
      const end = line.indexOf('`', i + 1);
      if (end === -1) { pushTok(out, 'string', line.slice(i)); state.inTemplate = true; break; }
      pushTok(out, 'string', line.slice(i, end + 1)); i = end + 1; continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1; while (j < n && line[j] !== ch) { if (line[j] === '\\') j++; j++; }
      pushTok(out, 'string', line.slice(i, j + 1)); i = j + 1; continue;
    }
    if (/\s/.test(ch)) { let j = i; while (j < n && /\s/.test(line[j])) j++; pushTok(out, 'space', line.slice(i, j)); i = j; continue; }
    if (/[0-9]/.test(ch)) { let j = i; while (j < n && /[0-9._xa-fA-F]/.test(line[j])) j++; pushTok(out, 'number', line.slice(i, j)); i = j; continue; }
    if (/[A-Za-z_$@]/.test(ch)) {
      let j = i; while (j < n && /[A-Za-z0-9_$]/.test(line[j])) j++;
      const w = line.slice(i, j);
      const prev = out.length ? out[out.length - 1] : null;
      const prevNonSpace = [...out].reverse().find((t) => t.kind !== 'space');
      let kind = 'ident';
      const next = line.slice(j).match(/^\s*(.)/);
      const nextCh = next ? next[1] : '';
      if (KW.has(w)) kind = 'keyword';
      else if (prevNonSpace && (prevNonSpace.text === '<' || prevNonSpace.text === '</') && /^[A-Z]/.test(w) && (lang === 'tsx' || lang === 'js')) kind = 'tag';
      else if (prevNonSpace && (prevNonSpace.text === '<' || prevNonSpace.text === '</') && /^[a-z]/.test(w) && lang === 'tsx') kind = 'tag';
      else if (state.inTag && nextCh === '=') kind = 'attr';
      else if (TS_TYPES.has(w) || (/^[A-Z]/.test(w) && nextCh !== '(' && !(prevNonSpace && prevNonSpace.text === '.'))) kind = 'type';
      else if (nextCh === '(') kind = 'function';
      else if (prevNonSpace && prevNonSpace.text === '.') kind = 'property';
      else if (w.startsWith('@')) kind = 'comment';
      pushTok(out, kind, w); i = j; continue;
    }
    if (ch === '<' && (lang === 'tsx' || lang === 'js') && /^<\/?[A-Za-z>]/.test(line.slice(i))) {
      const t = line[i + 1] === '/' ? '</' : '<'; pushTok(out, 'punct', t); i += t.length; state.inTag = true; continue;
    }
    if ((ch === '>' || (ch === '/' && line[i + 1] === '>')) && state.inTag) { const t = ch === '/' ? '/>' : '>'; pushTok(out, 'punct', t); i += t.length; state.inTag = false; continue; }
    if ('{}()[];,.'.includes(ch)) { pushTok(out, 'punct', ch); i++; continue; }
    let j = i; while (j < n && '=+-*/%<>!&|?:^~'.includes(line[j])) j++;
    if (j > i) { pushTok(out, 'operator', line.slice(i, j)); i = j; continue; }
    pushTok(out, 'text', ch); i++;
  }
  return out;
}

function tokenizeJson(line) {
  const out = []; let i = 0; const n = line.length;
  while (i < n) {
    const ch = line[i];
    if (ch === '"') { let j = i + 1; while (j < n && line[j] !== '"') { if (line[j] === '\\') j++; j++; } const s = line.slice(i, j + 1); const isKey = /^\s*:/.test(line.slice(j + 1)); pushTok(out, isKey ? 'property' : 'string', s); i = j + 1; continue; }
    if (/\s/.test(ch)) { let j = i; while (j < n && /\s/.test(line[j])) j++; pushTok(out, 'space', line.slice(i, j)); i = j; continue; }
    if (/[-0-9]/.test(ch)) { let j = i; while (j < n && /[-0-9.eE+]/.test(line[j])) j++; pushTok(out, 'number', line.slice(i, j)); i = j; continue; }
    if (/[a-z]/.test(ch)) { let j = i; while (j < n && /[a-z]/.test(line[j])) j++; pushTok(out, 'keyword', line.slice(i, j)); i = j; continue; }
    pushTok(out, 'punct', ch); i++;
  }
  return out;
}

function tokenizeCss(line, state) {
  const out = []; let i = 0; const n = line.length;
  if (state.inBlock) { const end = line.indexOf('*/'); if (end === -1) return [{ kind: 'comment', text: line }]; pushTok(out, 'comment', line.slice(0, end + 2)); i = end + 2; state.inBlock = false; }
  while (i < n) {
    const ch = line[i];
    if (ch === '/' && line[i + 1] === '*') { const end = line.indexOf('*/', i); if (end === -1) { pushTok(out, 'comment', line.slice(i)); state.inBlock = true; break; } pushTok(out, 'comment', line.slice(i, end + 2)); i = end + 2; continue; }
    if (ch === '"' || ch === "'") { let j = i + 1; while (j < n && line[j] !== ch) j++; pushTok(out, 'string', line.slice(i, j + 1)); i = j + 1; continue; }
    if (/\s/.test(ch)) { let j = i; while (j < n && /\s/.test(line[j])) j++; pushTok(out, 'space', line.slice(i, j)); i = j; continue; }
    if (ch === '{') { state.inRule = true; pushTok(out, 'punct', ch); i++; continue; }
    if (ch === '}') { state.inRule = false; pushTok(out, 'punct', ch); i++; continue; }
    if (ch === '@') { let j = i + 1; while (j < n && /[a-z-]/.test(line[j])) j++; pushTok(out, 'keyword', line.slice(i, j)); i = j; continue; }
    if (/[#0-9.]/.test(ch) && /[0-9a-fA-F.]/.test(line[i + 1] || '')) { let j = i + 1; while (j < n && /[0-9a-zA-Z.%]/.test(line[j])) j++; pushTok(out, 'number', line.slice(i, j)); i = j; continue; }
    if (/[A-Za-z_-]/.test(ch)) {
      let j = i; while (j < n && /[A-Za-z0-9_-]/.test(line[j])) j++; const w = line.slice(i, j);
      const inParens = out.some((t) => t.text === '(') && !out.some((t) => t.text === ')');
      const decl = state.inRule && /^\s*:/.test(line.slice(j)) && !inParens;
      pushTok(out, decl ? 'property' : state.inRule ? (w.startsWith('--') ? 'variable' : (/^\s*\(/.test(line.slice(j)) ? 'function' : 'ident')) : (w.startsWith('--') ? 'variable' : 'tag'), w); i = j; continue;
    }
    if (ch === '.' || ch === ':') { let j = i + 1; while (j < n && /[A-Za-z0-9_-]/.test(line[j])) j++; if (!state.inRule) { pushTok(out, ch === '.' ? 'attr' : 'keyword', line.slice(i, j)); i = j; continue; } }
    pushTok(out, 'punct', ch); i++;
  }
  return out;
}

function tokenizeHtml(line, state) {
  const out = []; let i = 0; const n = line.length;
  while (i < n) {
    const ch = line[i];
    if (ch === '<' && line.slice(i, i + 4) === '<!--') { const end = line.indexOf('-->', i); const e = end === -1 ? n : end + 3; pushTok(out, 'comment', line.slice(i, e)); i = e; continue; }
    if (ch === '<') { let j = i + 1; if (line[j] === '/' || line[j] === '!') j++; while (j < n && /[A-Za-z0-9-]/.test(line[j])) j++; pushTok(out, 'punct', line.slice(i, i + (line[i + 1] === '/' ? 2 : 1))); pushTok(out, 'tag', line.slice(i + (line[i + 1] === '/' ? 2 : 1), j)); i = j; state.inTag = true; continue; }
    if (ch === '>' || (ch === '/' && line[i + 1] === '>')) { const t = ch === '/' ? '/>' : '>'; pushTok(out, 'punct', t); i += t.length; state.inTag = false; continue; }
    if (state.inTag) {
      if (/\s/.test(ch)) { let j = i; while (j < n && /\s/.test(line[j])) j++; pushTok(out, 'space', line.slice(i, j)); i = j; continue; }
      if (ch === '"' || ch === "'") { let j = i + 1; while (j < n && line[j] !== ch) j++; pushTok(out, 'string', line.slice(i, j + 1)); i = j + 1; continue; }
      if (ch === '=') { pushTok(out, 'operator', ch); i++; continue; }
      let j = i; while (j < n && /[A-Za-z0-9:-]/.test(line[j])) j++; if (j === i) j++; pushTok(out, 'attr', line.slice(i, j)); i = j; continue;
    }
    let j = i; while (j < n && line[j] !== '<') j++; const txt = line.slice(i, j); pushTok(out, /^\s*$/.test(txt) ? 'space' : 'text', txt); i = j;
  }
  return out;
}

function tokenizeMd(line, state) {
  if (line.startsWith('```')) { state.inFence = !state.inFence; return [{ kind: 'punct', text: line }]; }
  if (state.inFence) return [{ kind: 'string', text: line }];
  if (/^#{1,6}\s/.test(line)) return [{ kind: 'heading', text: line }];
  const out = []; let i = 0; const n = line.length;
  const m = line.match(/^(\s*)([-*]|\d+\.)\s/);
  if (m) { pushTok(out, 'space', m[1]); pushTok(out, 'keyword', m[2] + ' '); i = m[0].length; }
  while (i < n) {
    const rest = line.slice(i);
    let mm;
    if ((mm = rest.match(/^\*\*[^*]+\*\*/))) { pushTok(out, 'strong', mm[0]); i += mm[0].length; continue; }
    if ((mm = rest.match(/^`[^`]+`/))) { pushTok(out, 'string', mm[0]); i += mm[0].length; continue; }
    if ((mm = rest.match(/^\[[^\]]+\]\([^)]+\)/))) { pushTok(out, 'link', mm[0]); i += mm[0].length; continue; }
    if ((mm = rest.match(/^https?:\/\/\S+/))) { pushTok(out, 'link', mm[0]); i += mm[0].length; continue; }
    let j = i + 1; while (j < n && !'*`[h'.includes(line[j])) j++;
    pushTok(out, 'text', line.slice(i, j)); i = j;
  }
  return out;
}

export function tokenize(content, lang) {
  const state = {};
  return content.split('\n').map((l) => tokenizeLine(l, lang, state));
}

// Split tokens into segments carrying decoration flags for ranges [{from,to,cls}] (0-based cols within the line)
export function segmentLine(tokens, ranges) {
  if (!ranges.length) return tokens.map((t) => ({ ...t }));
  const cuts = new Set();
  ranges.forEach((r) => { cuts.add(r.from); cuts.add(r.to); });
  const out = []; let col = 0;
  for (const t of tokens) {
    const start = col, end = col + t.text.length;
    const inner = [...cuts].filter((c) => c > start && c < end).sort((a, b) => a - b);
    let prev = start;
    for (const c of inner.concat([end])) {
      const text = t.text.slice(prev - start, c - start);
      const seg = { kind: t.kind, text };
      for (const r of ranges) if (prev >= r.from && c <= r.to) seg[r.cls] = true;
      out.push(seg); prev = c;
    }
    col = end;
  }
  return out;
}

export function foldRanges(lines) {
  const ranges = []; const stack = [];
  lines.forEach((l, i) => {
    const opens = (l.match(/[{([]/g) || []).length, closes = (l.match(/[})\]]/g) || []).length;
    if (opens > closes) stack.push(i);
    else if (closes > opens && stack.length) { const s = stack.pop(); if (i - s >= 2) ranges.push({ start: s, end: i - 1 }); }
  });
  return ranges;
}

export function offsetToPos(text, offset) {
  const before = text.slice(0, offset); const lines = before.split('\n');
  return { line: lines.length, col: lines[lines.length - 1].length + 1 };
}
export function posToOffset(text, line, col) {
  const lines = text.split('\n'); let off = 0;
  for (let i = 0; i < line - 1 && i < lines.length; i++) off += lines[i].length + 1;
  return off + (col - 1);
}
export function wordAt(text, offset) {
  let s = offset, e = offset;
  while (s > 0 && /[A-Za-z0-9_$]/.test(text[s - 1])) s--;
  while (e < text.length && /[A-Za-z0-9_$]/.test(text[e])) e++;
  return { word: text.slice(s, e), start: s, end: e };
}

export function findMatches(text, query, opts) {
  if (!query) return [];
  let re;
  try {
    let src = opts.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (opts.wholeWord) src = `\\b${src}\\b`;
    re = new RegExp(src, opts.caseSensitive ? 'g' : 'gi');
  } catch (e) { return { error: e.message }; }
  const out = []; let m; let guard = 0;
  while ((m = re.exec(text)) && guard++ < 5000) { if (m[0] === '') { re.lastIndex++; continue; } out.push({ start: m.index, end: m.index + m[0].length, text: m[0] }); }
  return out;
}

// Simple LCS line diff → [{type:'same'|'add'|'del', a?, b?, text}]
export function diffLines(a, b) {
  const A = a.split('\n'), B = b.split('\n');
  const n = A.length, m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = []; let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push({ type: 'same', a: i + 1, b: j + 1, text: A[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: 'del', a: i + 1, text: A[i] }); i++; }
    else { out.push({ type: 'add', b: j + 1, text: B[j] }); j++; }
  }
  while (i < n) { out.push({ type: 'del', a: i + 1, text: A[i++] }); }
  while (j < m) { out.push({ type: 'add', b: j + 1, text: B[j++] }); }
  return out;
}
// Pair del/add into side-by-side rows
export function sideBySide(diff) {
  const rows = []; let i = 0;
  while (i < diff.length) {
    const d = diff[i];
    if (d.type === 'same') { rows.push({ l: d, r: d }); i++; continue; }
    const dels = [], adds = [];
    while (i < diff.length && diff[i].type === 'del') dels.push(diff[i++]);
    while (i < diff.length && diff[i].type === 'add') adds.push(diff[i++]);
    const len = Math.max(dels.length, adds.length);
    for (let k = 0; k < len; k++) rows.push({ l: dels[k] || null, r: adds[k] || null });
  }
  return rows;
}

export function parseMarkdown(md) {
  const blocks = []; const lines = md.split('\n'); let i = 0;
  const inline = (s) => {
    const out = []; const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g; let last = 0; let m;
    while ((m = re.exec(s))) {
      if (m.index > last) out.push({ text: s.slice(last, m.index) });
      const t = m[0];
      if (t.startsWith('**')) out.push({ text: t.slice(2, -2), bold: true });
      else if (t.startsWith('`')) out.push({ text: t.slice(1, -1), code: true });
      else { const mm = t.match(/^\[([^\]]+)\]\(([^)]+)\)/); out.push({ text: mm[1], link: mm[2] }); }
      last = m.index + t.length;
    }
    if (last < s.length) out.push({ text: s.slice(last) });
    return out;
  };
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    if (l.startsWith('```')) { const code = []; i++; while (i < lines.length && !lines[i].startsWith('```')) code.push(lines[i++]); i++; blocks.push({ type: 'code', text: code.join('\n') }); continue; }
    const h = l.match(/^(#{1,6})\s+(.*)/);
    if (h) { blocks.push({ type: 'h' + h[1].length, inlines: inline(h[2]) }); i++; continue; }
    if (/^\s*([-*]|\d+\.)\s/.test(l)) { const items = []; while (i < lines.length && /^\s*([-*]|\d+\.)\s/.test(lines[i])) { const mm = lines[i].match(/^\s*([-*]|\d+\.)\s+(.*)/); items.push({ marker: /\d/.test(mm[1]) ? mm[1] : '•', inlines: inline(mm[2]) }); i++; } blocks.push({ type: 'list', items }); continue; }
    const para = []; while (i < lines.length && lines[i].trim() && !/^(#|```|\s*([-*]|\d+\.)\s)/.test(lines[i])) para.push(lines[i++]);
    blocks.push({ type: 'p', inlines: inline(para.join(' ')) });
  }
  return blocks;
}

export function fuzzy(query, target) {
  if (!query) return { score: 1, marks: [] };
  const q = query.toLowerCase(), t = target.toLowerCase();
  let ti = 0, score = 0; const marks = [];
  for (let qi = 0; qi < q.length; qi++) {
    const idx = t.indexOf(q[qi], ti);
    if (idx === -1) return null;
    score += idx === ti ? 3 : 1; if (idx === 0 || /[\/._\- ]/.test(t[idx - 1])) score += 2;
    marks.push(idx); ti = idx + 1;
  }
  return { score: score - target.length * 0.01, marks };
}
export function markChars(text, marks) {
  const set = new Set(marks);
  return text.split('').map((c, i) => ({ c, hit: set.has(i) }));
}

export function formatSource(text) {
  return text.split('\n').map((l) => l
    .replace(/\s+$/, '')
    .replace(/([^\s=!<>])=([^\s=>])/g, '$1 = $2')
    .replace(/=>(\S)/g, '=> $1').replace(/(\S)=>/g, '$1 =>')
    .replace(/,(\S)/g, ', $1')
    .replace(/:([^\s/])/g, (m, g, off, s) => (/https?$/.test(s.slice(0, off)) ? m : ': ' + g))
    .replace(/^(\s{4})(\s*return)/, '  $2'),
  ).join('\n').replace(/\n*$/, '\n');
}
