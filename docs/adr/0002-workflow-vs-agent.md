# 0002. Workflow, not agent

Status: accepted
Date: 2026-10-31
Related: docs/brief.md
Approved by: kickoff synthesis (2026-10-31)

## Context
Every source (meeting, email, idea, session) follows a path known in advance: receive, normalize, optionally one LLM step, validate, scrub, write, commit. The open-ended decisions (what to search, what to save) are taken by the MCP clients, which are outside this system.

## Decision
We will build fixed workflows. LLM steps are single calls with a fixed prompt and a Zod-validated output (email criteria, inbox classification, routines). No step lets a model choose the next step.

## Alternatives considered
| Option | Why rejected |
|---|---|
| Agent that decides how to file each input | The paths are few and drawable; autonomy adds cost, skipped steps and untestable behavior |

## Consequences
- Positive: Each step is testable with fixtures; LLM cost is predictable per input.
- Negative: Inputs that fit no path go to the inbox instead of being handled creatively.
- Revisit when: A source appears whose handling cannot be drawn as a fixed flow.
