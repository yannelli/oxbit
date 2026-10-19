# AI inline completion models

Created: 2026-10-19. Last updated: 2026-10-19.

`packages/features/ai/src/models.ts` lists the models the Settings page suggests under **AI model**. Inline completions send a chat request on each pause in typing, so the list favors low latency and low price per request. This page records where each number came from. Update both files together.

## Scores

- **AA**: Artificial Analysis Intelligence Index v4.3.2, from each model's page, at the model's highest reasoning effort. Inline completions run with little or no reasoning, so expect lower quality than these scores suggest.
- **LCB**: Vals AI's LiveCodeBench v6 run, page dated 2026-09-01.
- **SWE-bench Verified**: vendor-reported; used for one local model without an AA or LCB score.

Prices are USD per 1M input / output tokens. Some models cost more for long prompts; inline completion prompts are about 8,000 characters, so the base price applies.

## OpenRouter

Prices and context come from the live `GET https://openrouter.ai/api/v1/models` payload on 2026-10-19. That endpoint answers without a key; `pricing.prompt` and `pricing.completion` are USD per token.

| Model ID | Price | Context | Score | Notes |
| --- | --- | --- | --- | --- |
| `inception/mercury-2.5` | $0.04 / $0.15 | 260K | AA 12 | Diffusion model, released 2026-09-08. |
| `openai/gpt-6-luna` | $0.10 / $0.50 | 1.05M | AA 38 | Released 2026-09-22. |
| `anthropic/claude-haiku-5.5` | $0.10 / $0.50 | 1M | AA 43 | AA article 2026-10-07. |
| `deepseek/deepseek-v4.1-flash` | $0.0344 / $0.08 | 1.05M | AA 39 | Released 2026-09-10. |
| `google/gemini-3.5-flash-lite` | $0.30 / $2.50 | 1.05M | LCB 79.01%, AA 22 | Reasoning is mandatory, default `minimal`. |

The first four accept reasoning effort `none`. `z-ai/glm-5.3-flash` is left out because its reasoning is mandatory and defaults to `max`.

## OpenAI API

Prices from the OpenAI pricing page; context windows from models.dev.

| Model ID | Price | Context | Score |
| --- | --- | --- | --- |
| `gpt-6-luna` | $0.10 / $0.50 | 1.05M | AA 38 |
| `gpt-5-nano` | $0.05 / $0.40 | 400K | LCB 70.22% |
| `gpt-5.4-nano` | $0.20 / $1.25 | 400K | LCB 84.01% |
| `gpt-5.4-mini` | $0.75 / $4.50 | 400K | LCB 81.47% |

AA lists `gpt-5.6-luna` as deprecated in favor of GPT-6 Luna.

## Anthropic API

| Model ID | Price | Context | Score |
| --- | --- | --- | --- |
| `claude-haiku-5-5` | $0.10 / $0.50 | 1M | AA 43 |
| `claude-sonnet-5-5` | $2.00 / $10.00 | 1M | AA 56 |

Claude Haiku 4.5 is a legacy model at $1.00 / $5.00 and is not suggested.

## Local (Ollama and llama.cpp)

IDs are `ollama pull` tags. For llama.cpp, download the GGUF repo and start `llama-server`; it serves `/v1/chat/completions` on port 8080 and ignores the model ID.

| Ollama tag | GGUF repo | Download | Score |
| --- | --- | --- | --- |
| `qwen3.6:35b-a3b-coding` | `unsloth/Qwen3.6-35B-A3B-GGUF` | 23-24 GB, 3B active | AA 18 |
| `qwen3.8:27b` | `unsloth/Qwen3.8-27B-GGUF` | 18 GB (q4_K_M) | LCB 84.00%, AA 34 |
| `gemma4:12b` | `unsloth/gemma-4-12b-it-GGUF` | 7.7-8.0 GB | AA 14 (AA estimate) |
| `qwen3.5:9b` | `unsloth/Qwen3.5-9B-GGUF` | 6.6-7.6 GB | AA 11 |
| `laguna-xs-2.1` | `poolside/Laguna-XS-2.1-GGUF` | 20 GB (q4_K_M), 33B total, 3B active | SWE-bench Verified 70.9% (vendor) |

The Laguna XS 2.1 Ollama page shows no 2026 date. Qwen models think by default; set `ai.effort` to `none` if completions arrive slowly.

## Catalog fields

- models.dev `api.json`: `{providerId: {models: {modelId: {cost: {input, output, cache_read, cache_write, tiers, context_over_200k}, limit: {context, output, input}, reasoning, release_date, status}}}}`, costs in USD per 1M tokens.
- OpenRouter `/api/v1/models`: `pricing.prompt`, `pricing.completion` (USD per token, `-1` for routers), `context_length`, `top_provider.max_completion_tokens`, `reasoning.mandatory`, `supported_efforts`, `default_effort`.

## Sources

All checked on 2026-10-19.

- https://openrouter.ai/api/v1/models
- https://models.dev/api.json
- https://developers.openai.com/api/docs/pricing
- https://platform.claude.com/docs/en/docs/about-claude/models/overview
- https://artificialanalysis.ai/articles/claude-haiku-5-5
- https://artificialanalysis.ai/models/gpt-6-luna, `/claude-haiku-5-5`, `/deepseek-v4-1-flash`, `/mercury-2-5`, `/gemini-3-5-flash-lite`, `/qwen3-8-27b`, `/qwen3-6-35b-a3b`, `/gemma-4-12b`, `/qwen3-5-9b`
- https://www.vals.ai/benchmarks/lcb
- https://ollama.com/library/qwen3.8, `/qwen3.6`, `/laguna-xs-2.1`, `/gemma4`, `/qwen3.5`
- https://huggingface.co/api/models (GGUF search)
