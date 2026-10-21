import { rmSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
// @ts-expect-error plain-node module without types
import { loadIndex } from "../../tools/agent-memory/lib/index-cache.mjs";
// @ts-expect-error plain-node module without types
import { queryTerms, searchIndex, stem, tokenize } from "../../tools/agent-memory/lib/lexical.mjs";
import { fixture } from "./fixtures";

const { root, config } = fixture();
const { index } = loadIndex(config, { repo: null });
const names = (hits: { path: string }[]) => hits.map((hit) => hit.path.split("/").pop());

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("tokenize", () => {
  it("splits camelCase, kebab-case and paths and drops stopwords", () => {
    expect(tokenize("the gitPush fails in ~/.codex/hooks.json")).toEqual(["git", "push", "fail", "codex", "hook"]);
  });

  it("stems plural and -ing forms to one term", () => {
    expect(stem("tags")).toBe(stem("tag"));
    expect(stem("publishing")).toBe(stem("publish"));
  });
});

describe("searchIndex", () => {
  it("ranks the note whose title and description match first", () => {
    const hits = searchIndex(index, "how do I warm the redis cache after a deploy?");
    expect(names(hits)[0]).toBe("redis-warmup.md");
    expect(hits[0].matched).toEqual(expect.arrayContaining(["warm", "redis", "cache", "deploy"]));
  });

  it("weights a title match above a passing body mention", () => {
    const hits = searchIndex(index, "redis");
    expect(names(hits).indexOf("redis-warmup.md")).toBeLessThan(names(hits).indexOf("docker-cache.md"));
  });

  it("matches a misspelled or British spelling through fuzzy expansion and says so", () => {
    const hits = searchIndex(index, "kuberntes rollout status");
    expect(names(hits)[0]).toBe("kubernetes-rollout.md");
    expect(hits[0].matched.some((word: string) => word.startsWith("kuberntes~"))).toBe(true);
  });

  it("drops hits below minTerms and minScore", () => {
    expect(searchIndex(index, "advisory", { minTerms: 2 })).toEqual([]);
    expect(searchIndex(index, "advisory lock", { minTerms: 2 }).length).toBeGreaterThan(0);
    expect(searchIndex(index, "advisory lock", { minScore: 1000 })).toEqual([]);
  });

  it("keeps the rarest known terms when tool output floods the query", () => {
    const noise = Array.from({ length: 200 }, (_, i) => `zzword${i}`).join(" ");
    const terms = queryTerms(index, `${noise} gradle run`, 6);
    expect(terms).toContain("gradle");
    expect(terms.length).toBeLessThanOrEqual(6);
  });
});
