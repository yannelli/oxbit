# Memory hook

Created: 2026-10-21. Last updated: 2026-10-21.

`tools/agent-memory/` is an optional hook for Claude Code, Codex and Cursor. It matches the agent's prompt or shell command and output against Markdown memory notes and adds up to 3 pointer lines, each an openable path with the reason it matched. It is off until you run the enable script.

## Setup

```sh
node tools/agent-memory/bin/enable.mjs                  # all three tools
node tools/agent-memory/bin/enable.mjs --tools claude   # one tool
node tools/agent-memory/bin/disable.mjs                 # remove every entry it added
node tools/agent-memory/bin/index.mjs                   # build the lexical index now
node tools/agent-memory/bin/index.mjs --embed           # also build vectors (optional path)
node tools/agent-memory/bin/bench.mjs 100 --embed       # per-call latency
```

| Tool | File the enable script writes | Committed |
| --- | --- | --- |
| Claude Code | `<repo>/.claude/settings.local.json` | no, `.claude/` is in `.gitignore` |
| Codex | `~/.codex/hooks.json`, with `--project <repo>` on the command | no, user scope |
| Cursor | `~/.cursor/hooks.json` (`version: 1`), with `--project <repo>` | no, user scope |

The scripts merge into an existing file: other hooks stay, a second enable replaces the earlier entries, and disable deletes the file when nothing else is left. Codex runs a new non-managed hook only after you review it in `/hooks` ([Codex hooks](https://learn.chatgpt.com/docs/hooks)). `AGENT_MEMORY_DISABLED=1` turns the hook off for one shell.

Settings live in `~/.config/agent-memory/config.json` (or the file in `AGENT_MEMORY_CONFIG`) and merge over the defaults in `tools/agent-memory/lib/config.mjs`. The default `sources` are `~/.claude/projects/*/memory/*.md`, `$CLAUDE_CONFIG_DIR/projects/*/memory/*.md`, `~/.agents/shared/**/*.md` and `{repo}/docs/**/*.md`, where `{repo}` is the git root of the agent's working directory. Files are deduped by real path and chunks by content, and `MEMORY.md` index files are skipped.

## How it works

1. Index. Each file over 3,000 characters is split at `##` and `###` headings, so a line points at `path:line`. Term counts per field (title and path, description, body) are cached in `~/.cache/agent-memory/` per file, keyed by mtime and size. When a file changed, the hook answers from the old index and rebuilds it in a detached process.
2. Query. A prompt is used as is. A shell tool call uses the command plus the head and tail of stderr and stdout (4,000 characters), and other tools are skipped. Terms are stemmed and split on camelCase, kebab-case and paths; the 24 rarest known terms are kept, plus up to 4 unknown terms for fuzzy matching (backed by BM25Q and the query-robustness study below).
3. Rank. BM25F with field weights 3, 2 and 1 and k1 1.2 (BM25S, BRIGHT). A term missing from the vocabulary expands to terms within edit distance 1, or 2 for 8+ letters, or a shared 5+ letter prefix, at reduced weight (MiniSearch). A hit needs a score of 4 and 75% of the top score, and either 3 matched terms or 2 terms with a score of 7, so weak matches print nothing (context rot, NoisyBench).
4. Optional embeddings. With `embedding.enabled`, `pickBackend` checks free memory (`vm_stat` or `/proc/meminfo`), CPU count, load per CPU, power (`pmset` or `/sys/class/power_supply`, Low Power Mode) and model presence (Ollama `/api/tags`, llama.cpp `/health`, MLX `mlx_embeddings` plus the Hugging Face cache) before anything loads, and caches the answer for 60 s. Backends are an existing Ollama or llama.cpp server on GPU or CPU (`device: cpu` sends `num_gpu: 0`), or a `mlx_server.py` sidecar on Apple silicon. The query embedding gets a 150 ms budget; a failed check, missing vectors or a timeout leaves the lexical result. Results fuse by RRF with k 60 (Zep, BM25 to corrective RAG). There is no reranker: it does not fit the budget (SkillRet).
5. Inject. Output is JSON `additionalContext` (`additional_context` for Cursor): a header and at most 3 lines and 900 characters per call, 6,000 per epoch, well under the 10,000-character Claude Code cap and 2,500-token Codex cap.

Session state sits in `~/.cache/agent-memory/sessions/`, one file per tool, session id and agent id, so a subagent with its own `agent_id` (or `subagent_id`) starts fresh. A note shown in a session stays quiet until one of these holds:

- compaction: `PreCompact`, `PostCompact` or `SessionStart` with source `compact` or `clear` starts a new epoch. On `SessionStart` `compact`, the hook re-adds the 3 notes matched most often before compaction.
- context growth: the transcript file grew 400,000 bytes since the note was shown, or 120 hook calls passed when the tool gives no transcript.
- time: 45 minutes passed.

Every call appends a line to `~/.cache/agent-memory/hook.log.jsonl` with the ids shown, the reason, the backend and the time taken. Errors end the call with exit 0 and no output, and a 2 s timer exits the process.

## Hook support by tool (read 2026-10-21)

| Need | Claude Code ([hooks](https://code.claude.com/docs/en/hooks)) | Codex ([hooks](https://learn.chatgpt.com/docs/hooks)) | Cursor ([hooks](https://cursor.com/docs/agent/hooks)) |
| --- | --- | --- | --- |
| Match the prompt | `UserPromptSubmit` | `UserPromptSubmit` | none: `beforeSubmitPrompt` returns only `continue` and `user_message` |
| Match shell output | `PostToolUse`, matcher `Bash` | `PostToolUse`, filtered in the hook | `postToolUse` with `additional_context` |
| Notice compaction | `PreCompact`, `SessionStart` source `compact` | `PreCompact`, `SessionStart` source `compact` | `preCompact`, observe only |
| Re-add notes after compaction | `SessionStart` `compact` | `SessionStart` `compact` | none: `preCompact` cannot add context, so notes return on the next matching tool call |
| Tell subagents apart | `agent_id` on tool events | not documented for tool events: "Subagent hooks use the parent session id" | `subagent_id` on `subagentStart` only |

Cursor forum reports from 2026 say `additional_context` from `postToolUse` and `sessionStart` was dropped in some builds ([thread](https://forum.cursor.com/t/bug-beforesubmitprompt-hook-updated-input-is-silently-stripped-modified-prompt-never-reaches-the-model/158883)). In Codex, tool calls inside a subagent share the parent's state until Codex documents an agent id on those events.

## Measurements

Measured 2026-10-21 on an M1 Max (10 cores, 64 GB, AC power) with load averages between 52 and 66, against the default sources on that machine: 337 files, 2,383 chunks, 9,261 terms. Each figure times a whole `node` hook process from spawn to exit, with a fresh session per call (`bin/bench.mjs`).

| Path | Calls | p50 | p95 | Result |
| --- | --- | --- | --- | --- |
| Lexical | 100 | 97 ms | 127 ms | under the 150 ms target |
| Ollama `embeddinggemma:300m-qat-q8_0`, forced past the resource check, 150 ms budget | 100 | 252 ms | 282 ms | 100 of 100 hit the budget and returned the lexical result |
| Same, 2 s budget | 50 | 228 ms | 288 ms | 50 of 50 used embeddings |

- Cold index build: 265 to 437 ms. A warm index loads in about 50 ms (file walk about 30 ms, JSON parse about 17 ms).
- Vector cache: 2,386 chunks in 133 s, 7.3 MB.
- Without `AGENT_MEMORY_FORCE_BACKEND`, `pickBackend` refused the embedding path on this machine with `load 6.56/cpu > 1`, which is the intended choice at that load.
- Prompts unrelated to the corpus (a haiku request, arithmetic, a rename) printed nothing.

## Research

Sources were read on 2026-10-21. Each entry lists the link, the reported numbers, and the design choice it backs. Vendor results on their own systems are marked as self-reported.

### Memory retrieval for coding and long-running agents

- Mem0 paper, 2025-04-28: https://arxiv.org/abs/2504.19413 (Table 2 in https://arxiv.org/html/2504.19413v1)
  - LoCoMo, LLM-judge J score: full context 72.90 (26,031 tokens), Mem0 graph 68.44 (3,616 tokens), Mem0 66.88 (1,764 tokens), Zep 65.99, best RAG 60.97 (k=2, 256-token chunks), LangMem 58.10, OpenAI memory 52.90, A-Mem 48.38.
  - Mem0 search latency p50 0.148 s, p95 0.200 s. Full context p95 total latency about 17 s.
  - Injection count: not reported for answer retrieval; the update phase compares against 10 similar memories.
  - Backs: inject a small set of short notes. Full context scores higher at 15x the tokens, which a per-call hook cannot afford.
- Zep paper, 2025-01-20: https://arxiv.org/html/2501.13956v1
  - Search combines cosine similarity, BM25 (Lucene) and breadth-first graph expansion; rerankers include RRF, MMR and a cross-encoder; BGE-m3 for embedding and reranking.
  - Injects the 20 most relevant facts plus 20 entity summaries (top 10 in the DMR run).
  - LongMemEval: context 1.6k tokens vs 115k for full context. gpt-4o accuracy 71.2 vs 60.2, latency 2.58 s vs 28.9 s. gpt-4o-mini 63.8 vs 55.4.
  - Self-reported.
  - Backs: lexical plus vector retrieval fused by rank in the optional path.
- Letta blog, 2025-08-12: https://www.letta.com/blog/benchmarking-ai-agent-memory
  - A gpt-4o-mini agent with conversation history in files and `grep` plus `search_files` scores 74.0% on LoCoMo; Mem0 reports 68.5% for its graph variant.
  - Injection count: the agent decides what to open; there is no fixed k.
  - Self-reported.
  - Backs: plain Markdown files with lexical search as the default store; the hook points at files and the agent opens them.
- LongMemEval-V2, 2026-05-12: https://arxiv.org/abs/2605.12493
  - 451 questions on web-agent trajectories, up to 500 trajectories and 115M tokens per question.
  - AgentRunbook-C stores trajectories as files and lets a coding agent search them: 72.5% average accuracy. Off-the-shelf coding agent 69.3%, strongest RAG baseline 48.5%. Coding-agent methods carry high latency (no figure in the abstract).
  - Backs: pointer lines to files the agent can read, with the hook doing a fast first pass.
- VibeMemBench, 2026-09-20: https://arxiv.org/abs/2609.23570
  - 111 coding targets from 90 SWE-rebench V2 repositories, 3,634 history trajectories.
  - Direct injection of verified experience raised task resolution on 4 of 5 solvers by 1.1 to 4.5 points and cut steps on all 5.
  - Across 4 existing memory systems, 11 of 12 solver and system pairs did not beat the memory-off baseline.
  - Backs: the hook stays optional and off by default; inject curated notes only.
- Training-free lexical-dense fusion, 2026-06-02: https://arxiv.org/abs/2606.04194
  - LoCoMo: adding BM25 to a late-interaction dense score raises Hit@1 by 8.8 to 17.2 points across 6 encoders. With e5-large-v2, Hit@1 0.752 and NDCG@5 0.829, 11.2 points above BM25.
  - LongMemEval-S: BM25 is already strong and the fusion gain is small and not significant.
  - Backs: BM25 as the default path; fusion as an opt-in gain on paraphrased queries.

### Lexical ranking

- Lighting the way for BRIGHT, 2025-09-02 (v2 2026-06-01): https://arxiv.org/html/2509.02558v2
  - BRIGHT nDCG@10, bag-of-words BM25 vs BM25Q: overall 13.7 vs 14.8 (+1.1, p=0.056); coding subset 14.5 vs 16.5; Stack Overflow 16.3 vs 18.6.
  - BM25Q applies BM25 term saturation and length normalization to the query and squares IDF. Recommended for queries of about 16 to 256 tokens.
  - Backs: saturate repeated terms in long prompts, commands and tool output, and weight rare terms higher.
- Query-level RAG robustness, 2025-07-09 (GEM workshop, ACL 2025): https://arxiv.org/html/2507.06956
  - Recall@5 drop in points, NQ with 25% typos: BGE-base 30.24, Contriever 27.65, BM25 18.75.
  - Recall@5 drop with redundant text added to the query, BioASQ: BM25 20.21, BGE-base 3.05.
  - Backs: BM25 lost less to typos on NQ and HotpotQA (BioASQ reversed), and redundant query text hurt it most; strip boilerplate from tool output before scoring.
- GrepRAG, 2026-01-30: https://arxiv.org/abs/2601.23254v1
  - LLM-written ripgrep queries match graph-based retrieval for repository code completion. Identifier-weighted reranking plus deduplication adds 7.04% to 15.58% relative exact match on CrossCodeEval.
  - Listed limitation: noise from frequent, ambiguous keywords.
  - Backs: boost identifiers and paths, downweight common tokens, dedupe matches from the same note.
- Cursor semantic search post, 2025-11-06: https://cursor.com/en-US/blog/semsearch
  - Adding semantic search to a grep-equipped agent: 12.5% higher answer accuracy on average (6.5% to 23.5% by model); code retention +0.3%, +2.6% on codebases with 1,000+ files.
  - The agent keeps grep; the combination gives the best result.
  - Self-reported.
  - Backs: lexical default, embeddings as an additive opt-in.
- Background, BM25S, 2024-07-04: https://arxiv.org/html/2407.03618
  - Eager sparse scoring: up to 500x faster than the most popular Python BM25 package. ArguAna queries per second: BM25S 573.91, Elasticsearch 13.67, rank-bm25 2.00.
  - BEIR average nDCG@10 at k1=1.2, b=0.75: Lucene, ATIRE, BM25+ and Robertson 39.9, BM25L 39.5. Lucene at k1=0.9, b=0.4: 41.1.
  - Snowball stemming: 39.7 vs 38.4 without (English stopwords on); stopwords change the average by 0.1.
  - No 2025 or 2026 evaluation of BM25F, BM25+ or BM25L turned up in searches.
  - Backs: plain BM25 with a light stemmer and tuned k1 and b; variant choice moves BEIR by 0.4 at most.
  - Backs: precompute per-term scores at index time so a query is a sum over posting lists.
- Background, MiniSearch design document: https://github.com/lucaong/minisearch/blob/master/DESIGN_DOCUMENT.md
  - Radix tree index; fuzzy lookup computes a Levenshtein band of width 2d+1 and prunes subtrees above distance d; prefix search returns a subtree view. No timing numbers published.
  - Backs: prefix match plus edit distance 1 over a term trie in plain Node.

### Small embedding models for a laptop

- EmbeddingGemma, 2025-09-04 announcement and 2025-09-24 paper: https://developers.googleblog.com/en/introducing-embeddinggemma/, https://huggingface.co/blog/embeddinggemma, https://arxiv.org/abs/2509.20354, model card https://huggingface.co/google/embeddinggemma-300m
  - 300M parameters; top MTEB scores under 500M parameters for multilingual, English and code; the lead holds after weight quantization.
  - MTEB English v2 mean task: 69.67 at 768d, 68.37 at 256d, 66.66 at 128d. Multilingual v2: 61.15 at 768d. Code v1: 68.76 at 768d.
  - Quantized 768d English v2: Q8_0 69.49, Q4_0 69.31.
  - Under 15 ms for 256 input tokens on EdgeTPU. Under 200 MB RAM with quantization-aware training. 2K-token context. Queries and documents need task prefixes.
  - Supported in Ollama, llama.cpp and MLX.
  - Ollama: `embeddinggemma` (300m), 622 MB, needs Ollama 0.11.10 (https://ollama.com/library/embeddinggemma).
  - Backs: default model for the optional path (`embeddinggemma:300m-qat-q8_0`, 768d; Q8_0 costs 0.18 points on English v2).
- Qwen3-Embedding-0.6B, 2025-06-05: https://qwenlm.github.io/blog/qwen3-embedding/ and https://huggingface.co/Qwen/Qwen3-Embedding-0.6B
  - 1024d with Matryoshka truncation, 32K context.
  - MTEB multilingual 64.33, English v2 70.70, C-MTEB 66.33. BGE-M3 multilingual 59.56 in the same table.
  - Ollama: `qwen3-embedding:0.6b` is 639 MB; the `latest` tag is the 8B model at 4.7 GB (https://ollama.com/library/qwen3-embedding).
  - Community MLX port, self-reported: about 44,000 tokens/s for 0.6B at batch 32 on an M2 Max (https://github.com/jakedahn/qwen3-embeddings-mlx).
  - Backs: higher-quality alternative; config pins the `0.6b` tag.
- nomic-embed-text (Ollama library): https://ollama.com/library/nomic-embed-text
  - v1.5, 137M parameters, 274 MB, 2K context, needs Ollama 0.1.26. No v2 tag in the library.
  - Backs: smallest option for older Ollama installs.
- Ollama embedding catalog: https://ollama.com/search?c=embedding
  - Lists embeddinggemma, qwen3-embedding (0.6b, 4b, 8b), nomic-embed-text, mxbai-embed-large (335m), bge-m3 (567m), all-minilm (22m, 33m), snowflake-arctic-embed (22m to 335m) and granite-embedding (30m, 278m). There is no official bge-small entry.
  - Backs: detect installed models from this list instead of shipping weights.
- Static models (model2vec): https://github.com/MinishLab/model2vec/blob/main/results/README.md
  - MTEB average: potion-base-8M 51.08 (retrieval 31.11), potion-base-32M 52.13 (32.67), potion-retrieval-32M retrieval 35.06, all-MiniLM-L6-v2 55.93 (42.92).
  - Up to 500x faster on CPU than the source model; about 8 MB to 30 MB on disk. The README documents Python only.
  - Backs: no static model in the default path; retrieval scores sit about 8 points below MiniLM.

### Hybrid fusion and rerankers

- From BM25 to corrective RAG, 2026-04-02: https://arxiv.org/html/2604.01733v1
  - Text and table documents, about 23K queries. nDCG@10 and Recall@5:
    - BM25: 0.515 and 0.644.
    - Dense (text-embedding-3-large): 0.466 and 0.587.
    - RRF with k=60: 0.551 and 0.695.
    - Hybrid plus Cohere Rerank: 0.683 and 0.816, through an API with no per-query latency reported.
  - Convex combination at alpha 0.5 reached Recall@5 0.726.
  - Backs: RRF with k=60 when both paths run; BM25 alone beats the dense model alone.
- Training-free lexical-dense fusion, 2026-06-02: https://arxiv.org/abs/2606.04194
  - BM25 fusion adds 8.8 to 17.2 Hit@1 on LoCoMo. An off-the-shelf web-search cross-encoder over the fused top 10 lowers Hit@1 by 6.9 points.
  - Backs: no generic reranker on memory notes.
- SkillRet, v3 2026-09-01: https://arxiv.org/html/2605.05726
  - One NVIDIA B200, bf16, FlashAttention-2: a 0.6B reranker takes 831 ms per query over 20 candidates, an 8B reranker 1.88 s. Query embedding takes 21.25 ms with a 0.6B model.
  - Reranking raised NDCG@10 from 86.44 to 87.74.
  - Backs: a cross-encoder reranker does not fit a 150 ms budget even on a datacenter GPU; one query embedding does.
- Qwen3-Reranker, 2025-06-05: https://qwenlm.github.io/blog/qwen3-embedding/
  - Reranking the top 100 from Qwen3-Embedding-0.6B. Columns are MTEB-R, MMTEB-R, MLDR and MTEB-Code:
    - Qwen3-Reranker-0.6B: 65.80, 66.36, 67.28, 73.42.
    - bge-reranker-v2-m3: 57.03, 58.36, 59.51, 41.38.
    - jina-multilingual-reranker-v2-base: 58.22, 63.73, 39.66, 58.98.
  - Self-reported.
  - Backs: if a reranker is added later outside the hook path, Qwen3-Reranker-0.6B is the quality pick.
- MemReranker, 2026-05-07: https://arxiv.org/abs/2605.06132
  - Rerankers built on Qwen3-Reranker for agent memory: the 4B model reaches 0.737 MAP, and the 0.6B model beats BGE-Reranker. Latency is 10% to 20% of large models; the abstract gives no milliseconds.
  - Backs: memory-tuned rerankers exist; latency still rules them out per call.
- Zep paper (topic 1), 2025-01-20: https://arxiv.org/html/2501.13956v1
  - Supports RRF, MMR and cross-encoder reranking; BGE-m3 for reranking; 1.6k-token context on LongMemEval.
  - Backs: a shipping memory system fuses BM25 and vector results by rank.

### Injection budgets

- Context rot (Chroma), 2025-07-14: https://www.trychroma.com/research/context-rot
  - 18 models, including GPT-4.1, Claude 4, Gemini 2.5 and Qwen3. Accuracy falls as input length grows.
  - One distractor lowers accuracy below the needle-only baseline, and four lower it further; the report gives the direction in charts without exact scores.
  - Lower question-to-needle similarity makes the decline steeper.
  - LongMemEval subset of 306 prompts: focused prompts of about 300 tokens score well above full prompts of about 113k tokens for every model.
  - Backs: inject 1 to 3 pointer lines; a weak match acts as a distractor.
- NoisyBench (Lost in the noise), 2026-01-12: https://arxiv.org/abs/2601.07226
  - 11 datasets across RAG, reasoning, alignment and tool use. Distractors are random documents, irrelevant chat history and hard negatives.
  - Accuracy drops up to 80% across the models tested (the abstract does not name them). Agentic workflows amplify errors by trusting noisy tool output.
  - Backs: a score threshold with an empty result as the common case; a near-miss note costs more than no note.
- Adaptive distraction, 2025-02-03 (v2 2025-09-21): https://arxiv.org/abs/2502.01609
  - Generated irrelevant but coherent additions cause an average drop over 45% across 4 benchmarks.
  - Backs: inject pointers instead of note bodies.
- Claude Code hooks reference (read 2026-10-21): https://code.claude.com/docs/en/hooks
  - `additionalContext` is wrapped in a system reminder, placed with the prompt for `UserPromptSubmit` and next to the tool result for `PreToolUse` and `PostToolUse`.
  - `additionalContext`, `systemMessage` and plain stdout are each capped at 10,000 characters with no override. Longer output is saved to a file, and Claude sees the path and a 2,000-character preview.
  - Plain stdout becomes context only for `UserPromptSubmit`, `UserPromptExpansion`, `SessionStart` and `PostModelSwitch`.
  - Command hook timeout defaults to 600 s, lowered to 30 s on `UserPromptSubmit`. A timed-out hook's output is discarded.
  - Backs: emit JSON `additionalContext` of a few hundred characters; set a short hook timeout.
- Codex hooks reference (read 2026-10-21): https://learn.chatgpt.com/docs/hooks
  - `UserPromptSubmit` stdout and `additionalContext` become developer context. `PostToolUse` ignores plain stdout and uses `additionalContext`.
  - Each model-visible hook message is limited to about 2,500 tokens by default (`additionalContextLimit`, 0 disables the cap). Longer output goes to a file under `<temp_dir>/hook_outputs/<session_id>/`, and the model gets a head-and-tail preview.
  - Default timeout 600 s.
  - Backs: one JSON output shape for both tools, kept far below 2,500 tokens.
