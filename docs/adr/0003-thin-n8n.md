# 0003. Thin n8n, logic in the tested service

Status: accepted
Date: 2026-10-31
Related: docs/brief.md
Approved by: kickoff synthesis (2026-10-31)

## Context
n8n already holds the owner's credentials (Gmail, Calendar, Notion, Telegram) and runs schedules. Logic written inside n8n nodes cannot be unit tested, cannot be verified by the build harness and is hard to ship to other users.

## Decision
We will keep n8n to triggers, credentials, Telegram approvals and calls to the task tool. n8n calls the service's internal HTTP endpoints, where naming, frontmatter, dedupe, scrubbing, LLM steps and git live. n8n workflows ship as importable templates in n8n/templates/ with no credentials inside.

## Alternatives considered
| Option | Why rejected |
|---|---|
| Logic in n8n Code nodes | No tests, no CI, not reviewable by the harness |
| No n8n, service holds every integration | Re-implements OAuth flows for Google, Notion and Telegram that n8n already solves |

## Consequences
- Positive: Logic is tested in CI; a third party only maps credentials in their n8n.
- Negative: Two moving parts; every source needs an endpoint and a template.
- Revisit when: A source needs logic that cannot cross the HTTP boundary cheaply.
