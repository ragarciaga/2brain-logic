# 0023. Emails are captured by label or by LLM criteria, with doubtful ones approved on Telegram in n8n

Status: proposed
Date: 2026-11-01
Related: docs/specs/06-capture/design.md, docs/adr/0003-thin-n8n.md, docs/adr/0021-capture-llm-and-spend-guard.md
Approved by: pending, with docs/specs/06-capture/design.md

## Context
The owner receives a few dozen emails a day per account; a few are worth keeping. Labelling each
by hand misses most of them, and keeping all of them floods the vault. The owner can describe what
matters in a short text. Some threads are borderline and need a human answer, which can take
hours. n8n holds the Gmail and Telegram credentials and has wait and resume for approvals
(ADR 0003); the service has no long-lived state outside the vault. A Telegram bot has one webhook,
already used by the capture-telegram workflow, and inline `callback_data` holds at most 64 bytes.

## Decision
We will capture every thread that carries the account's configured label (default `2brain`)
without asking the model whether to, and judge every other recent thread with one fixed model
call against `capture.email.criteria`, answering capture, skip or ask. The service stores nothing
for skip and ask. For ask, the Gmail template sends the owner chat a message with save and discard
buttons through the Telegram node's send and wait, holds the pending execution for up to 72
hours, and posts the thread again with `approved: true` only on save. n8n marks each thread with
a processed label after a final answer, so the poll does not see it again. One note per thread,
keyed by the thread id; no attachments.

## Alternatives considered
| Option | Why rejected |
|---|---|
| Label only | Misses relevant mail the owner did not label |
| LLM only, no label | The owner could not force a capture, and injected text could skip any thread |
| Store asked threads in an inbox for later review | Fills the vault with mail the owner may discard; reviewing there is slower than two buttons |
| Approval state and a resume route in the service | Duplicates n8n wait and resume and adds state outside the vault |
| Callback queries through the bot's single webhook | Callbacks land in the Telegram workflow and would need routing to the waiting Gmail execution through 64 bytes of data |
| Seen threads in n8n static data | Lost on re-import, so every thread would be asked again |

## Consequences
- Positive: Labelled mail is always kept and cannot be skipped by its own text; the rule lives in
  tested service code; n8n keeps the only pending state.
- Negative: Unlabelled mail text goes to the Anthropic API (owner accepted); n8n writes a label in
  the owner's mailbox; an unanswered ask expires, and keeping that thread later means removing the
  processed label and adding the capture label; each account is a duplicated workflow.
- Revisit when: The owner discards most asks or keeps most skips (tune the criteria first), or
  several accounts make duplicated workflows hard to maintain.
