# 0005. Vault in its own repository, Git as storage and sync

Status: accepted
Date: 2026-10-31
Related: docs/brief.md
Approved by: kickoff synthesis (2026-10-31)

## Context
The vault is edited by Obsidian Git on the owner's PC (auto commits every few minutes) and by the service on the server. A harness-managed code repository must not receive those commits.

## Decision
We will treat the vault as a separate Git repository. The service keeps a clone, runs `git pull --rebase` before each write and commits and pushes after it. Automations create new files whenever possible. On a rebase conflict the service keeps both versions (`<note> (conflict YYYY-MM-DD).md`), pushes, and raises an alert.

## Alternatives considered
| Option | Why rejected |
|---|---|
| Database plus export to Markdown | Two sources of truth; Obsidian would not see live data |
| Obsidian Sync | Paid, closed, no server-side access |

## Consequences
- Positive: History and backup for free; any Git host works.
- Negative: Writes are serialized through git; push latency adds seconds.
- Revisit when: Write volume makes git the bottleneck (more than a few writes per minute sustained).
