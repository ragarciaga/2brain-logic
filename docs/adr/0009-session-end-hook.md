# 0009. Session capture through Claude Code's native SessionEnd hook

Status: accepted
Date: 2026-10-31
Related: docs/brief.md
Approved by: kickoff synthesis (2026-10-31)

## Context
The source decision brief proposed adding a session summary and a configurable end-of-session hook to Rockbuilt. Claude Code already lets a plugin declare its own SessionEnd hook, and Rockbuilt already writes docs/progress.md in every project it manages.

## Decision
We will ship the capture in this repository's Claude Code plugin (plugin/): its SessionEnd hook reads docs/progress.md when it exists and otherwise builds its own summary, then saves decisions, recipes and people through the service. Rockbuilt is not changed, and nothing here writes to docs/progress.md.

## Alternatives considered
| Option | Why rejected |
|---|---|
| Change Rockbuilt as the brief proposed | Duplicates a native mechanism and grows a general harness for one consumer |

## Consequences
- Positive: No coupling to Rockbuilt's release cycle.
- Negative: Depends on the hook contract of Claude Code.
- Revisit when: SessionEnd cannot run long enough to push, or progress.md lacks what the vault needs.
