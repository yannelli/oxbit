import http from "node:http";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const agentFixture = path.resolve("tests/fixtures/agent-acp/agent.mjs");

/** Builds a tar.gz with a non-executable `bin/agent` script that runs the ACP fixture, plus an optional `bin/outside` symlink. */
export function buildArchive(dir, { outside } = {}) {
  const src = path.join(dir, "src");
  fs.mkdirSync(path.join(src, "bin"), { recursive: true });
  fs.writeFileSync(path.join(src, "bin/agent"), `#!/bin/sh\nexec "${process.execPath}" "${agentFixture}" "$@"\n`, { mode: 0o644 });
  if (outside) fs.symlinkSync(outside, path.join(src, "bin/outside"));
  const file = path.join(dir, "agent.tar.gz");
  execFileSync("tar", ["-czf", file, "-C", src, "."]);
  const data = fs.readFileSync(file);
  return { data, sha256: createHash("sha256").update(data).digest("hex") };
}

/** Serves `routes[url]` (an object or a function returning one) on 127.0.0.1 and counts requests per URL. */
export async function serve(routes = {}) {
  const hits = {};
  const server = http.createServer((req, res) => {
    hits[req.url] = (hits[req.url] ?? 0) + 1;
    const route = typeof routes[req.url] === "function" ? routes[req.url]() : routes[req.url];
    if (!route) return res.writeHead(404).end();
    res.writeHead(route.status ?? 200, route.headers ?? {});
    res.end(route.body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, hits, routes, close: () => new Promise((resolve) => server.close(resolve)) };
}

export const registryDocument = (agents) => JSON.stringify({ version: "1.0.0", agents });
