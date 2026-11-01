# 0021. Capture uses Claude Haiku 5.5 through src/llm with a monthly spend guard

Status: proposed
Date: 2026-11-01
Related: docs/specs/06-capture/design.md, docs/adr/0002-workflow-vs-agent.md
Approved by: pending, with docs/specs/06-capture/design.md

## Context
F6 needs one fixed model step per captured item: a title, an area, a type and tags for ideas, and
capture, skip or ask for unlabelled emails (ADR 0002). Volume is about 50 calls a day of about
2,000 input and 200 output tokens. The owner's cap is USD 20 a month (AGENTS.md, Paid services),
and today `src/llm/` has only the interface and a mock provider. The output picks among the
owner's configured areas and types, so it must be constrained and validated before it touches the
vault. Nothing in the service counts spend today, and a loop, a flood of mail or a retry storm
could call the API without limit.

## Decision
We will add an Anthropic provider (`@anthropic-ai/sdk` 1.3.0, pinned exact) behind the existing
`LlmProvider` interface, calling `claude-haiku-5-5` (USD 0.10 per million input tokens, USD 0.50
per million output) with low effort, no extended thinking, at most 400 output tokens and a JSON
schema output format whose enums come from the vault config; `completeStructured` validates the
answer with Zod and never throws. A spend guard in `src/llm/` adds the estimated cost of each
call from its usage tokens to a per-UTC-month counter persisted in `LLM_STATE_DIR`, refuses a
call whose worst case would pass the cap (the lower of `capture.llm.monthly_cap_usd` and
`LLM_MONTHLY_CAP_USD`, default USD 20), and fails closed when its file is unreadable. A refused,
failed, invalid or blocked call falls back to an unclassified inbox note or an ask; it never loses
an item. Without `ANTHROPIC_API_KEY` the service runs with every call failing over to the
fallback. Tests and default evals use the mock provider.

## Alternatives considered
| Option | Why rejected |
|---|---|
| Claude Sonnet 5.5 or Opus 5.5 | 20x to 40x the price for enum choices and a short title; Haiku quality is checked by the eval |
| Adaptive thinking or higher effort | Adds output tokens and latency without a measured gain on classification |
| Plain JSON in the prompt, no output format | More invalid outputs and fallbacks; the schema keeps enum values exact |
| Another provider or a local model | One provider first (docs/v2.md); a local model does not fit the 512 MB container |
| Rely only on the Anthropic console spend limit | Outside the repository and untested; it stays a second guard the owner can set |
| In-memory counter | Resets on restart, so a crash loop could pass the cap |

## Consequences
- Positive: Capture cost is about USD 0.45 a month, bounded by a tested guard; the model never
  chooses a value outside the config.
- Negative: A new dependency and a small state file outside the vault; prices are code constants
  that must be updated with the model; the estimate can drift from the bill (checked monthly by
  the owner, F6 R17.3).
- Revisit when: Anthropic prices or models change, the eval falls below its threshold, or another
  feature needs model calls with a different budget.
