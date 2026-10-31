# 0015. Public MCP app separate from the ingest app

Status: accepted
Date: 2026-10-31
Related: docs/adr/0007-mcp-auth.md, docs/adr/0010-ingest-bearer-token.md, docs/specs/02-mcp-server/
Approved by: the owner's standing instruction in the build session (2026-10-31), no cost involved

## Context
The ingest app checks `INGEST_TOKEN` on every route and must stay on the internal Docker network. OAuth routes and the MCP endpoint must be public behind the reverse proxy. Exempting routes inside one app means one list decides what is public.

## Decision
We will run a second Hono app in the same process on `MCP_PORT` (default 3001), started only when `PUBLIC_BASE_URL` is set, that serves only `/mcp`, the OAuth routes and `/.well-known/*`. The proxy routes only that port; the ingest port stays internal.

## Alternatives considered
| Option | Why rejected |
|---|---|
| One app with route exemptions from the ingest token | A wrong exemption exposes ingest; harder to reason about |
| A separate container | More memory next to n8n; two images to install |

## Consequences
- Positive: the public surface is one small router; the ingest app does not change.
- Negative: two ports to document in the installer (F4).
- Revisit when: the service moves to its own host.
