import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ACPRegistry, parseRegistry, pickDistribution, platformTarget } from "../src/acp-registry.js";
import { AgentACP } from "../src/agent-acp.js";
import { WorkspaceFiles } from "../src/filesystem.js";
// @ts-expect-error JavaScript fixture without type declarations
import { agentFixture, buildArchive, registryDocument, serve } from "../../../tests/fixtures/agent-acp-registry/server.mjs";

const target = platformTarget()!;
const npxAgent = { id: "npx-agent", name: "Npx Agent", version: "1.2.3", description: "Runs with npx", license: "MIT", distribution: { npx: { package: "npx-agent@1.2.3", args: ["--acp"], env: { MODE: "acp" } } } };
const binaryAgent = (archive: string, sha256: string | undefined, cmd = "./bin/agent") => ({
  id: "local-agent", name: "Local Agent", version: "0.1.0", description: "Binary fixture",
  distribution: { binary: { [target]: { archive, cmd, args: ["--history"], env: { FIXTURE_ENV: "set" }, ...(sha256 ? { sha256 } : {}) } } },
});

describe("ACP Registry", () => {
  const cleanups: (() => Promise<unknown>)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });
  async function temp() {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "oxbit-acp-registry-")));
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    return dir;
  }
  async function server(agents: unknown[]) {
    const host = await serve({ "/registry.json": () => ({ body: registryDocument(agents), headers: { "content-type": "application/json" } }) });
    cleanups.push(() => host.close());
    return host;
  }

  it("keeps valid entries and drops invalid ones", () => {
    const valid = { id: "ok.agent_1", name: "OK", version: "2026.10.01", description: "", distribution: { uvx: { package: "ok-agent" }, binary: { "freebsd-x86_64": { archive: "https://example.com/a.tar.gz", cmd: "a" } } } };
    const agents = parseRegistry(registryDocument([
      valid,
      { ...valid, name: "Duplicate" },
      { ...valid, id: "Bad-Case" },
      { ...valid, id: "traversal", version: "../x" },
      { ...valid, id: "no-dist", distribution: {} },
      { ...valid, id: "flag-package", distribution: { npx: { package: "--yes" } } },
      { ...valid, id: "bad-args", distribution: { npx: { package: "p", args: [1] } } },
      { ...valid, id: "bad-env", distribution: { uvx: { package: "p", env: { KEY: 1 } } } },
      { ...valid, id: "bad-sha", distribution: { binary: { [target]: { archive: "https://example.com/a.tgz", cmd: "a", sha256: "abc" } } } },
      { ...valid, id: "bad-url", distribution: { binary: { [target]: { archive: "file:///etc/passwd", cmd: "a" } } } },
      { ...valid, id: "no-name", name: 5 },
      "not an object",
    ]));
    expect(agents.map((a) => a.id)).toEqual(["ok.agent_1"]);
    expect(agents[0]!.distribution.binary).toEqual({});
    expect(() => parseRegistry("{}")).toThrow("no agents list");
  });

  it("maps platforms and prefers npx, then uvx, then the platform binary", () => {
    expect(platformTarget("darwin", "arm64")).toBe("darwin-aarch64");
    expect(platformTarget("win32", "x64")).toBe("windows-x86_64");
    expect(platformTarget("linux", "x64")).toBe("linux-x86_64");
    expect(platformTarget("freebsd", "x64")).toBeUndefined();
    const binary = { archive: "https://example.com/a.tar.gz", cmd: "a", args: [], env: {} };
    const agent = { id: "a", name: "A", version: "1", description: "", distribution: { npx: { package: "n", args: [], env: {} }, uvx: { package: "u", args: [], env: {} }, binary: { "linux-x86_64": binary } } };
    expect(pickDistribution(agent, "linux-x86_64")?.kind).toBe("npx");
    expect(pickDistribution({ ...agent, distribution: { uvx: agent.distribution.uvx, binary: agent.distribution.binary } })?.kind).toBe("uvx");
    expect(pickDistribution({ ...agent, distribution: { binary: agent.distribution.binary } }, "linux-x86_64")).toEqual({ kind: "binary", spec: binary });
    expect(pickDistribution({ ...agent, distribution: { binary: agent.distribution.binary } }, "darwin-aarch64")).toBeUndefined();
  });

  it("lists agents with availability and built-in presets, caches for 300 s, refreshes and falls back to the cache", async () => {
    const dataDir = await temp();
    const host = await server([
      npxAgent,
      { id: "codex-acp", name: "Codex", version: "9.9.9", description: "", distribution: { npx: { package: "@agentclientprotocol/codex-acp@9.9.9" } } },
      { id: "elsewhere", name: "Elsewhere", version: "1.0.0", description: "", distribution: { binary: { "freebsd-x86_64": { archive: "https://example.com/a.tgz", cmd: "a" } } } },
    ]);
    const registry = new ACPRegistry(dataDir, `${host.base}/registry.json`);
    const listing = await registry.listing();
    expect(listing.error).toBeUndefined();
    expect(listing.agents).toEqual([
      { id: "npx-agent", name: "Npx Agent", version: "1.2.3", description: "Runs with npx", license: "MIT", distribution: "npx", available: true },
      { id: "codex-acp", name: "Codex", version: "9.9.9", description: "", distribution: "npx", available: true, builtin: "codex" },
      { id: "elsewhere", name: "Elsewhere", version: "1.0.0", description: "", distribution: "binary", available: false },
    ]);
    await registry.listing();
    expect(host.hits["/registry.json"]).toBe(1);
    await registry.listing(true);
    expect(host.hits["/registry.json"]).toBe(2);

    const cacheFile = path.join(dataDir, "acp-registry.json");
    const cache = JSON.parse(await fs.readFile(cacheFile, "utf8"));
    await fs.writeFile(cacheFile, JSON.stringify({ ...cache, fetchedAt: new Date(Date.now() - 301_000).toISOString() }));
    await registry.listing();
    expect(host.hits["/registry.json"]).toBe(3);

    host.routes["/registry.json"] = () => ({ status: 500, body: "down" });
    const fallback = await registry.listing(true);
    expect(fallback.error).toContain("HTTP 500");
    expect(fallback.agents).toHaveLength(3);
    await expect(new ACPRegistry(await temp(), `${host.base}/registry.json`).listing()).rejects.toThrow("Could not reach the ACP Registry");
    await expect(new ACPRegistry(dataDir, `${host.base}/other.json`).listing()).rejects.toThrow("HTTP 404");
    await expect(new ACPRegistry(await temp(), "http://example.com/registry.json").listing()).rejects.toThrow("require HTTPS");
  });

  it("resolves npx agents with their environment and rejects unknown agents and stale versions", async () => {
    const host = await server([npxAgent, { ...npxAgent, id: "uvx-agent", distribution: { uvx: { package: "uvx-agent", args: ["acp"] } } }]);
    const registry = new ACPRegistry(await temp(), `${host.base}/registry.json`);
    expect(await registry.resolve("npx-agent")).toEqual({ name: "Npx Agent", command: "npx", args: ["-y", "npx-agent@1.2.3", "--acp"], env: { MODE: "acp" } });
    expect(await registry.resolve("uvx-agent", "1.2.3")).toEqual({ name: "Npx Agent", command: "uvx", args: ["uvx-agent", "acp"], env: {} });
    await expect(registry.resolve("missing")).rejects.toThrow("Unknown agent");
    await expect(registry.resolve("npx-agent", "1.0.0")).rejects.toThrow("refresh the agent list");
  });

  it("installs a verified binary once through a redirect and launches it", async () => {
    const dataDir = await temp(), root = await temp();
    const archive = buildArchive(await temp());
    const host = await server([]);
    host.routes["/agent.tar.gz"] = { body: archive.data };
    host.routes["/release/agent.tar.gz"] = { status: 302, headers: { location: "/agent.tar.gz" } };
    host.routes["/registry.json"] = { body: registryDocument([binaryAgent(`${host.base}/release/agent.tar.gz`, archive.sha256)]) };
    const registry = new ACPRegistry(dataDir, `${host.base}/registry.json`);
    const agent = new AgentACP(new WorkspaceFiles(root), () => {}, () => {}, registry);
    cleanups.push(async () => agent.dispose());

    const [first, second] = await Promise.all([
      agent.start("client", { provider: "local-agent", registry: { id: "local-agent", version: "0.1.0" } }),
      agent.start("client", { provider: "local-agent", registry: { id: "local-agent" } }),
    ]);
    expect(host.hits["/agent.tar.gz"]).toBe(1);
    expect(first).toMatchObject({ provider: "local-agent", name: "Local Agent" });
    expect(second.name).toBe("Local Agent");
    await agent.call("client", first.id, "session/new");
    await expect(agent.call("client", first.id, "session/prompt", { text: "Hello" })).resolves.toEqual({ stopReason: "end_turn" });
    const command = path.join(dataDir, "acp-agents/local-agent/0.1.0/bin/agent");
    expect((await fs.stat(command)).mode & 0o111).toBeTruthy();
    expect((await registry.listing()).agents[0]).toMatchObject({ distribution: "binary", available: true, installed: true });
    expect(await fs.readdir(path.join(dataDir, "acp-agents/local-agent"))).toEqual(["0.1.0"]);
  });

  it("rejects checksum mismatches, missing checksums, insecure downloads and commands that leave the install directory", async () => {
    const outside = await temp();
    const archive = buildArchive(await temp(), { outside: agentFixture });
    const host = await server([]);
    host.routes["/agent.tar.gz"] = { body: archive.data };
    const attempt = async (entry: ReturnType<typeof binaryAgent>) => {
      host.routes["/registry.json"] = { body: registryDocument([entry]) };
      const dataDir = await temp();
      const result = new ACPRegistry(dataDir, `${host.base}/registry.json`).resolve("local-agent");
      await result.catch(() => {});
      expect(await fs.readdir(path.join(dataDir, "acp-agents/local-agent")).catch(() => [])).toEqual([]);
      return result;
    };
    const url = `${host.base}/agent.tar.gz`;
    await expect(attempt(binaryAgent(url, "0".repeat(64)))).rejects.toThrow("does not match its sha256");
    await expect(attempt(binaryAgent(url, undefined))).rejects.toThrow("no sha256 checksum");
    await expect(attempt(binaryAgent("http://localhost:1/agent.tar.gz", archive.sha256))).rejects.toThrow("require HTTPS");
    await expect(attempt(binaryAgent(`${host.base}/agent.exe`, archive.sha256))).rejects.toThrow("cannot extract agent.exe");
    await expect(attempt(binaryAgent(url, archive.sha256, "../../escape"))).rejects.toThrow("outside its install directory");
    await expect(attempt(binaryAgent(url, archive.sha256, "./bin/outside"))).rejects.toThrow("outside its install directory");
    await expect(attempt(binaryAgent(url, archive.sha256, "./bin/missing"))).rejects.toThrow("has no ./bin/missing");
    expect(await fs.readdir(outside)).toEqual([]);
  });
});
