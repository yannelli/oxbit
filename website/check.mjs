import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const publicDir = path.resolve(fileURLToPath(new URL('./public/', import.meta.url)));
const origin = 'https://oxbit.dev';
const noindexRoutes = new Set(['/404.html', '/c/']);
const requiredRoutes = ['/', '/features/', '/platforms/', '/get-started/', '/docs/', '/changelog/', '/faq/', '/about/', '/support/', '/security/', '/privacy/'];
const primaryRoutes = ['/get-started/', '/features/', '/platforms/', '/docs/', '/changelog/'];
const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

function decode(value) {
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', copy: '©' };
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (!entity.startsWith('#')) return entities[entity.toLowerCase()] ?? match;
    const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}

function normalize(value) {
  return decode(value).replace(/\s+/g, ' ').trim();
}

function parseHtml(source) {
  const root = { tag: '#document', attrs: {}, children: [] };
  const stack = [root];
  const nodes = [];
  const tokens = /<!--[\s\S]*?-->|<![^>]*>|<(script|style)\b([^>]*)>([\s\S]*?)<\/\1\s*>|<\/?[a-z][^>]*>|[^<]+|</gi;
  const attributes = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (const match of source.matchAll(tokens)) {
    const token = match[0];
    if (token.startsWith('<!')) continue;
    if (token.startsWith('</')) {
      const tag = token.slice(2).match(/^[\w:-]+/)[0].toLowerCase();
      const index = stack.findLastIndex(node => node.tag === tag);
      if (index > 0) stack.length = index;
      continue;
    }
    if (!/^<[a-z]/i.test(token)) {
      stack.at(-1).children.push(token);
      continue;
    }
    const tag = (match[1] ?? token.slice(1).match(/^[\w:-]+/)[0]).toLowerCase();
    const attributeText = match[2] ?? token.slice(tag.length + 1, token.endsWith('/>') ? -2 : -1);
    const attrs = {};
    for (const attribute of attributeText.matchAll(attributes)) {
      attrs[attribute[1].toLowerCase()] = decode(attribute[2] ?? attribute[3] ?? attribute[4] ?? '');
    }
    const node = { tag, attrs, children: [], parent: stack.at(-1) };
    stack.at(-1).children.push(node);
    nodes.push(node);
    if (match[1]) node.children.push(match[3]);
    else if (!voidTags.has(tag) && !token.endsWith('/>')) stack.push(node);
  }
  return { root, nodes };
}

function textContent(node) {
  return node.children.map(child => typeof child === 'string' ? child : textContent(child)).join(' ');
}

function descendants(node, tag) {
  return node.children.flatMap(child => typeof child === 'string' ? [] : [
    ...(child.tag === tag ? [child] : []),
    ...descendants(child, tag),
  ]);
}

function htmlFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const filename = path.join(directory, entry.name);
    return entry.isDirectory() ? htmlFiles(filename) : entry.name.endsWith('.html') ? [filename] : [];
  });
}

const pages = htmlFiles(publicDir).map(filename => {
  const relative = path.relative(publicDir, filename).split(path.sep).join('/');
  const route = relative === 'index.html' ? '/' : relative.endsWith('/index.html') ? `/${relative.slice(0, -10)}` : `/${relative}`;
  const parsed = parseHtml(readFileSync(filename, 'utf8'));
  return { filename, route, ...parsed, indexable: !noindexRoutes.has(route) };
});
const byFilename = new Map(pages.map(page => [page.filename, page]));

function single(nodes, description) {
  assert.equal(nodes.length, 1, `Expected one ${description}; found ${nodes.length}`);
  return nodes[0];
}

function metadata(page, key) {
  const node = single(page.nodes.filter(node => node.tag === 'meta' && (node.attrs.name === key || node.attrs.property === key)), `${key} on ${page.route}`);
  assert.ok(normalize(node.attrs.content ?? ''), `Empty ${key} on ${page.route}`);
  return node.attrs.content;
}

function canonical(page) {
  return single(page.nodes.filter(node => node.tag === 'link' && node.attrs.rel?.split(/\s+/).includes('canonical')), `canonical on ${page.route}`).attrs.href;
}

function localTarget(value, page) {
  const url = new URL(value, `${origin}${page.route}`);
  if (url.origin !== origin) return null;
  const pathname = decodeURIComponent(url.pathname);
  const target = path.resolve(publicDir, `.${pathname}`);
  assert.ok(target === publicDir || target.startsWith(`${publicDir}${path.sep}`), `Path escapes public: ${value}`);
  const filename = existsSync(target) && statSync(target).isDirectory() ? path.join(target, 'index.html') : target;
  return { filename, url };
}

function structuredObjects(value) {
  if (Array.isArray(value)) return value.flatMap(structuredObjects);
  if (!value || typeof value !== 'object') return [];
  return [value, ...Object.values(value).flatMap(structuredObjects)];
}

function types(object) {
  return Array.isArray(object['@type']) ? object['@type'] : [object['@type']];
}

function structuredData(page) {
  return page.nodes.filter(node => node.tag === 'script' && node.attrs.type === 'application/ld+json').flatMap(node => {
    try {
      return structuredObjects(JSON.parse(textContent(node)));
    } catch (error) {
      assert.fail(`Invalid JSON-LD on ${page.route}: ${error.message}`);
    }
  });
}

test('required pages exist and have complete, unique search metadata', () => {
  for (const route of requiredRoutes) assert.ok(pages.some(page => page.route === route), `Missing route ${route}`);
  assert.ok(pages.some(page => page.route === '/404.html'), 'Missing 404 page');
  const titles = new Set();
  const descriptions = new Set();
  for (const page of pages) {
    const title = normalize(textContent(single(page.nodes.filter(node => node.tag === 'title'), `title on ${page.route}`)));
    const description = normalize(metadata(page, 'description'));
    assert.ok(title, `Empty title on ${page.route}`);
    assert.ok(!titles.has(title), `Duplicate title: ${title}`);
    assert.ok(!descriptions.has(description), `Duplicate description on ${page.route}`);
    titles.add(title);
    descriptions.add(description);
    const html = single(page.nodes.filter(node => node.tag === 'html'), `html on ${page.route}`);
    assert.ok(html.attrs.lang?.trim(), `Missing language on ${page.route}`);
    assert.match(metadata(page, 'viewport'), /width\s*=\s*device-width/, `Missing responsive viewport on ${page.route}`);
    const heading = single(page.nodes.filter(node => node.tag === 'h1'), `h1 on ${page.route}`);
    assert.ok(normalize(textContent(heading)), `Empty h1 on ${page.route}`);
    const main = single(page.nodes.filter(node => node.tag === 'main'), `main on ${page.route}`);
    assert.equal(main.attrs.id, 'main', `Missing main#main on ${page.route}`);
    if (page.indexable) {
      assert.equal(canonical(page), `${origin}${page.route}`, `Incorrect canonical on ${page.route}`);
      const robots = page.nodes.find(node => node.tag === 'meta' && node.attrs.name === 'robots');
      assert.ok(!robots || !/\b(noindex|none)\b/i.test(robots.attrs.content), `Indexable page blocks indexing: ${page.route}`);
    } else {
      assert.match(metadata(page, 'robots'), /\bnoindex\b/i, `${page.route} must be noindex`);
    }
  }
});

test('indexable pages have social metadata and valid structured data', () => {
  for (const page of pages.filter(page => page.indexable)) {
    for (const key of ['og:title', 'og:description', 'twitter:title', 'twitter:description']) metadata(page, key);
    assert.equal(metadata(page, 'og:url'), `${origin}${page.route}`, `Incorrect og:url on ${page.route}`);
    assert.equal(metadata(page, 'og:type'), 'website', `Incorrect og:type on ${page.route}`);
    assert.equal(metadata(page, 'twitter:card'), 'summary_large_image', `Incorrect Twitter card on ${page.route}`);
    for (const key of ['og:image', 'twitter:image']) {
      const value = metadata(page, key);
      assert.match(value, /^https:\/\//, `Use an absolute HTTPS ${key} on ${page.route}`);
      const target = localTarget(value, page);
      if (target) assert.ok(existsSync(target.filename), `Missing social image ${value}`);
    }
    const objects = structuredData(page);
    const pageObjects = objects.filter(object => types(object).some(type => ['WebPage', 'FAQPage', 'CollectionPage'].includes(type)));
    assert.ok(pageObjects.length, `Missing page JSON-LD on ${page.route}`);
    for (const object of pageObjects) {
      assert.equal(object.url ?? object['@id'], `${origin}${page.route}`, `Incorrect structured page URL on ${page.route}`);
      assert.ok(normalize(object.name ?? ''), `Missing structured page name on ${page.route}`);
    }
    for (const object of objects.filter(object => types(object).includes('SoftwareApplication'))) {
      assert.ok(normalize(object.name ?? ''), `Missing application name on ${page.route}`);
      assert.ok(object.operatingSystem, `Missing application operatingSystem on ${page.route}`);
      assert.ok(object.applicationCategory, `Missing applicationCategory on ${page.route}`);
      assert.match(object.url, /^https:\/\//, `Missing application URL on ${page.route}`);
    }
    if (page.route === '/faq/') assert.ok(pageObjects.some(object => types(object).includes('FAQPage')), 'FAQ route needs FAQPage JSON-LD');
    const faq = objects.filter(object => types(object).includes('FAQPage'));
    if (faq.length) {
      const details = page.nodes.filter(node => node.tag === 'details' && node.attrs.class?.split(/\s+/).includes('faq-item'));
      const visible = details.map(node => ({
        question: normalize(textContent(single(descendants(node, 'summary'), `FAQ summary on ${page.route}`))),
        answer: normalize(descendants(node, 'p').map(textContent).join(' ')),
      }));
      assert.ok(visible.length, `FAQPage has no visible FAQ items on ${page.route}`);
      const questions = faq.flatMap(object => object.mainEntity ?? []);
      assert.equal(questions.length, visible.length, `FAQ schema and visible item count differ on ${page.route}`);
      assert.deepEqual(questions.map(question => {
        assert.ok(types(question).includes('Question'), `Invalid FAQ Question on ${page.route}`);
        assert.ok(types(question.acceptedAnswer ?? {}).includes('Answer'), `Invalid FAQ Answer on ${page.route}`);
        return { question: normalize(question.name ?? ''), answer: normalize(question.acceptedAnswer.text ?? '') };
      }), visible, `FAQ schema differs from visible text on ${page.route}`);
    }
  }
});

test('local links, assets, and fragment targets exist without duplicate IDs', () => {
  for (const page of pages) {
    const ids = page.nodes.filter(node => 'id' in node.attrs).map(node => node.attrs.id);
    assert.ok(ids.every(Boolean), `Empty ID on ${page.route}`);
    assert.equal(new Set(ids).size, ids.length, `Duplicate ID on ${page.route}`);
    for (const node of page.nodes) {
      for (const key of ['href', 'src']) {
        if (!(key in node.attrs)) continue;
        const value = node.attrs[key];
        assert.ok(value.trim(), `Empty ${key} on ${page.route}`);
        const target = localTarget(value, page);
        if (!target) continue;
        assert.ok(existsSync(target.filename), `Broken ${key} ${value} on ${page.route}`);
        if (target.url.hash && byFilename.has(target.filename)) {
          const id = decodeURIComponent(target.url.hash.slice(1));
          assert.ok(byFilename.get(target.filename).nodes.some(candidate => candidate.attrs.id === id), `Missing fragment ${value} on ${page.route}`);
        }
      }
    }
  }
});

test('primary navigation, footer, and root navigation connect the site', () => {
  const graph = new Map();
  for (const page of pages) {
    const links = page.nodes.filter(node => node.tag === 'a').map(node => localTarget(node.attrs.href ?? '', page)).filter(Boolean);
    graph.set(page.filename, links.map(target => target.filename).filter(filename => byFilename.has(filename)));
    if (!page.indexable) continue;
    for (const tag of ['header', 'footer']) {
      const container = single(page.nodes.filter(node => node.tag === tag), `${tag} on ${page.route}`);
      const routes = descendants(container, 'a').map(node => localTarget(node.attrs.href ?? '', page)?.url.pathname);
      for (const route of primaryRoutes) assert.ok(routes.includes(route), `${tag} on ${page.route} lacks ${route}`);
    }
  }
  const visited = new Set();
  const queue = [path.join(publicDir, 'index.html')];
  while (queue.length) {
    const filename = queue.shift();
    if (visited.has(filename)) continue;
    visited.add(filename);
    queue.push(...(graph.get(filename) ?? []));
  }
  for (const page of pages.filter(page => page.indexable)) assert.ok(visited.has(page.filename), `${page.route} is unreachable from the homepage`);
});

test('sitemap and robots expose all indexable routes', () => {
  const sitemap = readFileSync(path.join(publicDir, 'sitemap.xml'), 'utf8');
  assert.match(sitemap, /<urlset\b[^>]*xmlns=["']http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9["']/, 'Missing sitemap namespace');
  const urls = [...sitemap.matchAll(/<loc\b[^>]*>([\s\S]*?)<\/loc>/g)].map(match => decode(match[1].trim()));
  assert.equal(urls.length, new Set(urls).size, 'Duplicate sitemap URL');
  assert.deepEqual([...urls].sort(), pages.filter(page => page.indexable).map(canonical).sort(), 'Sitemap differs from canonical page routes');
  const robots = readFileSync(path.join(publicDir, 'robots.txt'), 'utf8');
  const directives = robots.split(/\r?\n/).map(line => line.replace(/#.*/, '').trim()).filter(Boolean);
  assert.ok(directives.some(line => /^user-agent:\s*\*$/i.test(line)), 'Missing general robots user agent');
  assert.ok(directives.some(line => /^sitemap:\s*https:\/\/oxbit\.dev\/sitemap\.xml$/i.test(line)), 'Missing sitemap directive');
  for (const line of directives.filter(line => /^disallow:/i.test(line))) {
    assert.equal(line.split(':').slice(1).join(':').trim(), '', `Unexpected robots block: ${line}`);
  }
});
