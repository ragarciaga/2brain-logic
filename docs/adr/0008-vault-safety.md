# 0008. Deterministic secret scrub; nothing is deleted from a vault

Status: accepted
Date: 2026-10-31
Related: docs/brief.md
Approved by: kickoff synthesis (2026-10-31)

## Context
Inputs (emails, transcripts, session summaries) can carry passwords, API keys, tokens, account and card numbers or ID numbers. A prompt instruction is not a control. Owners also want a guarantee that automations never lose notes.

## Decision
We will run a deterministic scrubber (pattern and entropy rules, tested with fixtures) on every write before commit, replacing matches with a placeholder and logging the rule, never the value. No code path deletes a vault file: removal moves it to the configured archive folder. External deletions (for example old Fireflies recordings) are opt-in, run only after the transcript is confirmed in the vault and pushed, and are logged in the vault.

## Alternatives considered
| Option | Why rejected |
|---|---|
| LLM-based redaction | Non-deterministic and costs per write |

## Consequences
- Positive: Secrets do not reach Git history; notes are recoverable.
- Negative: False positives may mask harmless strings; the scrubber needs a fixture suite.
- Revisit when: A secret reaches the vault despite the scrubber (add the case, then revisit).
