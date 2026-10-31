# 0004. Meetings make zero LLM calls

Status: accepted
Date: 2026-10-31
Related: docs/brief.md
Approved by: kickoff synthesis (2026-10-31)

## Context
Meeting transcripts are the largest input (tens of thousands of tokens each, often two versions of the same meeting). Analyzing them through the API would dominate the USD 20/month budget. The owner already pays for a Claude subscription and analyzes meetings with the analizar-reunion skill, which reads the transcript from the vault and writes the analysis back.

## Decision
We will make the meeting flow deterministic: n8n receives the transcript (Fireflies or Gemini), the service names it from the overlapping calendar event (`YYYY-MM-DD · Event title`, or `YYYY-MM-DD · Untitled meeting HH-MM` in the configured language), drops recordings of 5 minutes or less, stores it under the area's meetings folder with the source suffix when both sources exist, and commits. Speaker labels are stored as delivered. Analysis is out of scope for the service.

## Alternatives considered
| Option | Why rejected |
|---|---|
| LLM summary and speaker suggestion in the pipeline | Highest API cost of the system; duplicates what the subscription skill does better with the owner's history |

## Consequences
- Positive: Meeting ingest costs nothing per meeting and is fully testable; the transcript exists once, in the vault.
- Negative: No analysis appears until the owner runs the skill.
- Revisit when: The owner wants analyses without asking for them and accepts the API cost.
