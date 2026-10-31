# 0007. MCP never public without OAuth 2.1

Status: accepted
Date: 2026-10-31
Related: docs/brief.md
Approved by: kickoff synthesis (2026-10-31)

## Context
The MCP server exposes the whole vault (personal and work data) to claude.ai, ChatGPT and CLIs. claude.ai and ChatGPT connectors authenticate remote servers with OAuth; a static token in a URL leaks.

## Decision
We will publish the MCP endpoint only behind OAuth 2.1 for a single owner per install, and keep the ingest API on the internal Docker network with no public route. Until OAuth passes its tests, the reverse proxy has no public route to the service. The implementation (built-in authorization server versus an external provider) is a benchmark in the F2 spec.

## Alternatives considered
| Option | Why rejected |
|---|---|
| Bearer token only | Not accepted by the claude.ai connector flow; easy to leak |
| No auth behind an obscure URL | Rejected outright |

## Consequences
- Positive: One rule for every client; no endpoint is ever open.
- Negative: OAuth adds work before the first remote query.
- Revisit when: A target client cannot complete the OAuth flow.
