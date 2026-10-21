const STOPWORDS = new Set(
  ('a an and are as at be but by can do does for from has have how i if in into is it its me my no not of on or our ' +
    'so that the their then there these this to was we were what when where which who why will with you your ' +
    'all any also been before after each just more most must only other over same should some such than them ' +
    'they up use used using via would yes let lets get got make made need see now new one two file files line lines ' +
    'true false null undefined const return import export function var string number md txt json')
    .split(' '),
);

export const FIELDS = Object.freeze({ title: 0, description: 1, body: 2 });
const FIELD_WEIGHTS = [3, 2, 1];
const FIELD_B = [0.3, 0.5, 0.75];
const K1 = 1.2;

export function stem(token) {
  if (token.length <= 3 || /\d/.test(token)) return token;
  if (token.length === 4) return token.endsWith('s') && !token.endsWith('ss') ? token.slice(0, 3) : token;
  for (const suffix of ['ations', 'ation', 'ings', 'ing', 'edly', 'ies', 'ers', 'ed', 'es', 'er', 'ly', 's']) {
    if (token.endsWith(suffix) && token.length - suffix.length >= 4) {
      const base = token.slice(0, -suffix.length);
      return suffix === 'ies' ? `${base}y` : base;
    }
  }
  return token;
}

/** Splits camelCase, kebab-case, snake_case and paths into `[stem, surface]` pairs. */
export function tokenizePairs(text) {
  const pairs = [];
  const spaced = String(text)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase();
  for (const raw of spaced.split(/[^a-z0-9]+/)) {
    if (raw.length < 2 || raw.length > 32 || STOPWORDS.has(raw) || /^\d{1,2}$/.test(raw)) continue;
    pairs.push([stem(raw), raw]);
  }
  return pairs;
}

export function tokenize(text) {
  return tokenizePairs(text).map(([term]) => term);
}

function countTerms(text) {
  const counts = new Map();
  for (const term of tokenize(text)) counts.set(term, (counts.get(term) ?? 0) + 1);
  return counts;
}

/** Field term counts for one chunk; stored per file so unchanged files skip tokenizing. */
export function analyzeChunk(chunk) {
  const pathWords = chunk.path.split('/').slice(-3).join(' ');
  const fields = [`${chunk.title} ${pathWords}`, chunk.description, chunk.text].map(countTerms);
  const lengths = fields.map((counts) => [...counts.values()].reduce((sum, value) => sum + value, 0));
  const terms = {};
  fields.forEach((counts, field) => {
    for (const [term, count] of counts) {
      terms[term] ??= [0, 0, 0];
      terms[term][field] = count;
    }
  });
  return { lengths, terms };
}

/** Builds postings from analyzed chunks: `{ docs, avg, postings: { term: [docIndex, tfTitle, tfDesc, tfBody, ...] } }`. */
export function buildIndex(analyzed) {
  const docs = [];
  const postings = new Map();
  const totals = [0, 0, 0];
  analyzed.forEach(({ chunk, analysis }, docIndex) => {
    docs.push({ id: chunk.id, path: chunk.path, line: chunk.line, title: chunk.title, description: chunk.description, lengths: analysis.lengths });
    analysis.lengths.forEach((length, field) => (totals[field] += length));
    for (const [term, tfs] of Object.entries(analysis.terms)) {
      let list = postings.get(term);
      if (!list) postings.set(term, (list = []));
      list.push(docIndex, tfs[0], tfs[1], tfs[2]);
    }
  });
  const avg = totals.map((total) => Math.max(1, total / Math.max(1, docs.length)));
  return { docs, avg, postings };
}

/** Postings are arrays after a build and `"df|doc,tf,tf,tf;..."` strings after a cache load. */
export function postingsFor(index, term) {
  const value = index.postings.get(term);
  if (typeof value !== 'string') return value;
  const list = value.slice(value.indexOf('|') + 1).split(/[;,]/).map(Number);
  index.postings.set(term, list);
  return list;
}

export function docFrequency(index, term) {
  const value = index.postings.get(term);
  if (value === undefined) return 0;
  return typeof value === 'string' ? Number.parseInt(value, 10) : value.length / 4;
}

export function encodePostings(postings) {
  const out = {};
  for (const [term, list] of postings) {
    const groups = [];
    for (let offset = 0; offset < list.length; offset += 4) groups.push(list.slice(offset, offset + 4).join(','));
    out[term] = `${list.length / 4}|${groups.join(';')}`;
  }
  return out;
}

function editDistanceAtMost(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return false;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      rowMin = Math.min(rowMin, current[j]);
    }
    if (rowMin > max) return false;
    previous = current;
  }
  return previous[b.length] <= max;
}

function vocabularyByLength(index) {
  if (index.vocabByLength) return index.vocabByLength;
  const byLength = new Map();
  for (const term of index.postings.keys()) {
    if (!byLength.has(term.length)) byLength.set(term.length, []);
    byLength.get(term.length).push(term);
  }
  index.vocabByLength = byLength;
  return byLength;
}

/** Vocabulary terms within edit distance 1 (2 for 8+ letters) or sharing a 5+ letter prefix. */
export function fuzzyExpand(index, term, limit = 3) {
  if (term.length < 4 || /\d/.test(term)) return [];
  const max = term.length >= 8 ? 2 : 1;
  const candidates = [];
  const byLength = vocabularyByLength(index);
  for (let length = term.length - max; length <= term.length + 4; length += 1) {
    for (const other of byLength.get(length) ?? []) {
      if (other === term) continue;
      const prefix = term.length >= 5 && other.length >= 5 && (other.startsWith(term) || term.startsWith(other));
      if (prefix) candidates.push({ term: other, weight: 0.7 });
      else if (Math.abs(length - term.length) <= max && editDistanceAtMost(term, other, max)) candidates.push({ term: other, weight: 0.5 });
    }
  }
  const df = (candidate) => docFrequency(index, candidate.term);
  return candidates.sort((a, b) => b.weight - a.weight || df(b) - df(a)).slice(0, limit);
}

function idf(index, docFrequency) {
  const n = index.docs.length;
  return Math.log(1 + (n - docFrequency + 0.5) / (docFrequency + 0.5));
}

/** Picks the rarest known terms, then a few unknown ones for fuzzy matching, so long tool output does not flood the query. */
export function queryTerms(index, text, maxTerms, maxUnknown = 4) {
  const known = [];
  const unknown = [];
  for (const term of new Set(tokenize(text))) (docFrequency(index, term) > 0 ? known : unknown).push(term);
  known.sort((a, b) => docFrequency(index, a) - docFrequency(index, b));
  const picked = known.slice(0, maxTerms);
  return picked.concat(unknown.slice(0, Math.min(maxUnknown, maxTerms - picked.length)));
}

/** BM25F with fuzzy expansion. Returns hits with the query terms each one matched. */
export function searchIndex(index, text, { maxTerms = 24, minScore = 0, minTerms = 1, limit = 10 } = {}) {
  const scores = new Map();
  const surface = new Map();
  for (const [term, raw] of tokenizePairs(text)) if (!surface.has(term)) surface.set(term, raw);
  for (const queryTerm of queryTerms(index, text, maxTerms)) {
    const expansions = index.postings.has(queryTerm) ? [{ term: queryTerm, weight: 1 }] : fuzzyExpand(index, queryTerm);
    for (const { term, weight } of expansions) {
      const list = postingsFor(index, term);
      const termIdf = idf(index, list.length / 4) * weight;
      for (let offset = 0; offset < list.length; offset += 4) {
        const doc = index.docs[list[offset]];
        let tf = 0;
        for (let field = 0; field < 3; field += 1) {
          const raw = list[offset + 1 + field];
          if (raw) tf += (FIELD_WEIGHTS[field] * raw) / (1 - FIELD_B[field] + (FIELD_B[field] * doc.lengths[field]) / index.avg[field]);
        }
        const entry = scores.get(list[offset]) ?? { score: 0, matched: new Map() };
        entry.score += (termIdf * tf) / (K1 + tf);
        if (!entry.matched.has(queryTerm)) entry.matched.set(queryTerm, weight === 1 ? null : term);
        scores.set(list[offset], entry);
      }
    }
  }
  return [...scores.entries()]
    .filter(([, entry]) => entry.score >= minScore && entry.matched.size >= minTerms)
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, limit)
    .map(([docIndex, entry]) => ({
      ...index.docs[docIndex],
      score: Number(entry.score.toFixed(3)),
      matched: [...entry.matched.entries()].map(([query, term]) => {
        const word = surface.get(query) ?? query;
        return term === null ? word : `${word}~${term}`;
      }),
    }));
}
