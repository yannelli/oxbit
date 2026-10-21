import { appendFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error plain-node module without types
import { mergeConfig } from "../../tools/agent-memory/lib/config.mjs";
// @ts-expect-error plain-node module without types
import { runHook } from "../../tools/agent-memory/lib/run.mjs";
import { fixture } from "./fixtures";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function setup(overrides: Record<string, unknown> = {}) {
  const made = fixture(overrides);
  roots.push(made.root);
  return made;
}

const PROMPT = "how do I warm the redis cache after a deploy?";

async function prompt(config: unknown, prompt: string, extra: Record<string, unknown> = {}, now = Date.now(), tool = "claude") {
  const event = tool === "cursor" ? "postToolUse" : "UserPromptSubmit";
  const input = tool === "cursor" ? { conversation_id: "c1", tool_name: "Shell", tool_input: { command: prompt }, ...extra } : { session_id: "s1", prompt, ...extra };
  return runHook({ tool, event, input, config, now });
}

function context(stdout: string) {
  if (!stdout) return "";
  const parsed = JSON.parse(stdout);
  return parsed.hookSpecificOutput?.additionalContext ?? parsed.additional_context;
}

describe("dedupe and budget", () => {
  it("shows a matching memory once per session", async () => {
    const { config } = setup();
    const first = await prompt(config, PROMPT);
    expect(context(first.stdout)).toContain("redis-warmup.md");
    expect(context(first.stdout)).toMatch(/matched .*redis/);
    const second = await prompt(config, PROMPT);
    expect(context(second.stdout)).not.toContain("redis-warmup.md");
  });

  it("gives a subagent its own session", async () => {
    const { config } = setup();
    await prompt(config, PROMPT);
    const sub = await prompt(config, PROMPT, { agent_id: "a1" });
    expect(context(sub.stdout)).toContain("redis-warmup.md");
  });

  it("caps lines per call and characters per call and per epoch", async () => {
    const wide = "redis cache warm deploy migration advisory lock gradle heap kubernetes rollout docker layer";
    const lines = setup({ budget: { maxLines: 2, maxChars: 900, sessionMaxChars: 6000 } });
    expect(context((await prompt(lines.config, wide)).stdout).split("\n").length).toBe(3);
    const chars = setup({ budget: { maxLines: 3, maxChars: 260, sessionMaxChars: 6000 } });
    const text = context((await prompt(chars.config, wide)).stdout);
    for (const line of text.split("\n").slice(1)) expect(line.length).toBeLessThanOrEqual(260);
    const epoch = setup({ match: { minRelative: 0, minTerms: 1, minScore: 0 }, budget: { maxLines: 1, maxChars: 900, sessionMaxChars: 300 } });
    let total = 0;
    for (const query of ["redis warmup", "advisory lock", "gradle heap", "kubernetes rollout", "docker layer"]) {
      total += context((await prompt(epoch.config, query)).stdout).split("\n").slice(1).join("\n").length;
    }
    expect(total).toBeLessThanOrEqual(300);
  });

  it("stays silent on prompts that match nothing", async () => {
    const { config } = setup();
    expect((await prompt(config, "write a haiku about autumn leaves")).stdout).toBe("");
  });
});

describe("resurfacing", () => {
  it("brings memories back after compaction, first as carry-over then on match", async () => {
    const { config } = setup();
    await prompt(config, PROMPT);
    await runHook({ tool: "claude", event: "PreCompact", input: { session_id: "s1" }, config });
    const start = await runHook({ tool: "claude", event: "SessionStart", input: { session_id: "s1", source: "compact" }, config });
    expect(context(start.stdout)).toContain("from before compaction");
    expect(context(start.stdout)).toContain("redis-warmup.md");
    expect(context((await prompt(config, PROMPT)).stdout)).not.toContain("redis-warmup.md");
  });

  it("brings a memory back on match after compaction when carry-over did not include it", async () => {
    const { config } = setup({ resurface: { afterMs: 3_600_000, transcriptGrowthBytes: 400_000, callsWithoutTranscript: 120, onCompactLines: 0 } });
    await prompt(config, PROMPT);
    await runHook({ tool: "claude", event: "SessionStart", input: { session_id: "s1", source: "compact" }, config });
    expect(context((await prompt(config, PROMPT)).stdout)).toMatch(/redis-warmup\.md.*after compaction/);
  });

  it("brings a memory back after the elapsed-time window", async () => {
    const { config } = setup();
    const now = Date.now();
    await prompt(config, PROMPT, {}, now);
    expect(context((await prompt(config, PROMPT, {}, now + 60_000)).stdout)).not.toContain("redis-warmup.md");
    expect(context((await prompt(config, PROMPT, {}, now + config.resurface.afterMs)).stdout)).toMatch(/redis-warmup\.md.*time elapsed/);
  });

  it("brings a memory back after the transcript grows past the threshold", async () => {
    const { config, root } = setup({ resurface: { afterMs: 3_600_000, transcriptGrowthBytes: 1000, callsWithoutTranscript: 120, onCompactLines: 3 } });
    const transcript = join(root, "transcript.jsonl");
    writeFileSync(transcript, "x".repeat(100));
    await prompt(config, PROMPT, { transcript_path: transcript });
    appendFileSync(transcript, "x".repeat(500));
    expect(context((await prompt(config, PROMPT, { transcript_path: transcript })).stdout)).not.toContain("redis-warmup.md");
    appendFileSync(transcript, "x".repeat(600));
    expect(context((await prompt(config, PROMPT, { transcript_path: transcript })).stdout)).toMatch(/redis-warmup\.md.*context grew/);
  });

  it("counts hook calls as context growth when the tool gives no transcript", async () => {
    const { config } = setup({ resurface: { afterMs: 3_600_000, transcriptGrowthBytes: 400_000, callsWithoutTranscript: 3, onCompactLines: 3 } });
    expect(context((await prompt(config, "redis cache warmup", {}, Date.now(), "cursor")).stdout)).toContain("redis-warmup.md");
    for (let i = 0; i < 2; i += 1) expect(context((await prompt(config, "redis cache warmup", {}, Date.now(), "cursor")).stdout)).not.toContain("redis-warmup.md");
    expect(context((await prompt(config, "redis cache warmup", {}, Date.now(), "cursor")).stdout)).toContain("redis-warmup.md");
  });
});

describe("hook input handling", () => {
  it("matches shell commands and their output, and skips other tools", async () => {
    const { config } = setup();
    const bash = await runHook({ tool: "claude", event: "PostToolUse", input: { session_id: "s2", tool_name: "Bash", tool_input: { command: "psql -f migrate.sql" }, tool_response: { stdout: "", stderr: "migration failed: advisory lock held" } }, config });
    expect(context(bash.stdout)).toContain("postgres-migration-lock.md");
    const read = await runHook({ tool: "claude", event: "PostToolUse", input: { session_id: "s3", tool_name: "Read", tool_input: { file_path: "/x" }, tool_response: "advisory lock migration" }, config });
    expect(read.stdout).toBe("");
  });

  it("prints the JSON shape each tool reads", async () => {
    const { config } = setup();
    const claude = JSON.parse((await prompt(config, PROMPT)).stdout);
    expect(claude.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    const cursor = JSON.parse((await prompt(config, "redis cache warmup", {}, Date.now(), "cursor")).stdout);
    expect(typeof cursor.additional_context).toBe("string");
  });

  it("stays silent outside the --project directory", async () => {
    const { config, root } = setup();
    const result = await runHook({ tool: "codex", event: "UserPromptSubmit", input: { session_id: "s4", cwd: "/tmp/elsewhere", prompt: PROMPT }, config, project: root });
    expect(result.stdout).toBe("");
  });
});

describe("embedding fallback", () => {
  it("falls back to lexical results when the resource check fails", async () => {
    const { config } = setup();
    const enabled = mergeConfig(config, { embedding: { enabled: true, backend: "ollama", ollamaUrl: "http://127.0.0.1:9", minFreeMemoryMb: 10_000_000 } });
    const result = await runHook({ tool: "claude", event: "UserPromptSubmit", input: { session_id: "s5", prompt: PROMPT }, config: enabled, env: {} });
    expect(result.log.backend).toBe("lexical");
    expect(result.log.backendReason).toMatch(/free memory/);
    expect(context(result.stdout)).toContain("redis-warmup.md");
  });
});
