import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error plain-node module without types
import { DEFAULT_CONFIG, mergeConfig } from "../../tools/agent-memory/lib/config.mjs";

export const NOTES: Record<string, string> = {
  "redis-warmup.md":
    "---\nname: redis-warmup\ndescription: Warm the Redis cache after a deploy, before switching traffic\n---\n\nRun the warmup job, wait for the hit rate to settle, then flip the load balancer.\n",
  "postgres-migration-lock.md":
    "---\nname: postgres-migration-lock\ndescription: Migrations hold an advisory lock; a stuck lock blocks the next deploy\n---\n\nRelease it with pg_advisory_unlock when the migration pod crashed.\n",
  "gradle-daemon-memory.md":
    "---\nname: gradle-daemon-memory\ndescription: The Gradle daemon runs out of heap on CI\n---\n\nSet org.gradle.jvmargs to 4g in gradle.properties.\n",
  "kubernetes-rollout.md": "# Kubernetes rollout\n\nRun kubectl rollout status after apply and watch for crash loops.\n",
  "docker-cache.md": "# Docker layer cache\n\nThe CI build reuses the Docker layer cache. It mentions redis once.\n",
};

/** Writes the notes into a temp dir and returns a config whose only source is that dir; five notes give low IDF, so the score floors are low. */
export function fixture(overrides: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "agent-memory-"));
  const notes = join(root, "notes");
  mkdirSync(notes);
  for (const [name, text] of Object.entries(NOTES)) writeFileSync(join(notes, name), text);
  const base = mergeConfig(DEFAULT_CONFIG, { sources: [join(notes, "*.md")], cacheDir: join(root, "cache"), match: { minScore: 1, strongScore: 2 } });
  const config = mergeConfig(base, overrides);
  return { root, notes, config, cache: join(root, "cache") };
}
