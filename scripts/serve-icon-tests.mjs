// Isolated production browser checks with the effective desktop CSP.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { createHash } from 'node:crypto';
execFileSync('bun', ['run', '--filter', '@oxbit/web', 'build', '--', '--outDir', 'dist-icon-tests'], { stdio: 'inherit' });
const root = path.resolve('apps/web/dist-icon-tests');
const config = JSON.parse(await readFile('apps/desktop/src-tauri/tauri.conf.json', 'utf8'));
const html = await readFile(path.join(root, 'index.html'), 'utf8');
const importMap = html.match(/<script type="importmap">(.*?)<\/script>/s)?.[1];
const csp = importMap ? config.app.security.csp.replace("script-src 'self'", `script-src 'self' 'sha256-${createHash('sha256').update(importMap).digest('base64')}'`) : config.app.security.csp;
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff' };
const server = createServer(async (req, res) => {
  try {
    const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = path.resolve(root, '.' + (name === '/' ? '/index.html' : name));
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    const bytes = await readFile(file);
    res.writeHead(200, { 'content-type': mime[path.extname(file)] ?? 'application/octet-stream', 'content-security-policy': csp }); res.end(bytes);
  } catch { res.writeHead(404).end(); }
});
server.listen(9381, '127.0.0.1');
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => server.close(() => process.exit()));
