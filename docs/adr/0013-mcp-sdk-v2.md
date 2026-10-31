# 0013. MCP SDK v2 server package instead of the pinned v1 SDK

Status: accepted
Date: 2026-10-31
Related: docs/specs/02-mcp-server/, docs/research/mcp-oauth/REPORT.md, docs/adr/0001-stack.md
Approved by: the owner's standing instruction in the build session (2026-10-31), no cost involved

## Context
AGENTS.md pinned `@modelcontextprotocol/sdk` 1.32.2. The F2 benchmark found that 1.32.2 is the v1 maintenance line (MCP spec up to 2025-11-25, fixes promised until about 2027-01-27) and that its auth router and bearer middleware are Express only. SDK v2 ships as separate packages; `@modelcontextprotocol/server` 2.4.0 has a web-standard Streamable HTTP handler and resource-server helpers, no Express, and implements the 2026-07-28 spec with a 2025 fallback.

## Decision
We will use `@modelcontextprotocol/server` 2.4.0 (and `@modelcontextprotocol/client` 2.4.0 as a dev dependency for tests) instead of `@modelcontextprotocol/sdk` 1.32.2, pinned exactly.

## Alternatives considered
| Option | Why rejected |
|---|---|
| Keep `@modelcontextprotocol/sdk` 1.32.2 | Maintenance line, older spec, pulls in Express (92 extra packages, 17 MB) |
| `@hono/mcp` 0.3.5 | Needs SDK v1; protocol bugs found in the benchmark |

## Consequences
- Positive: web-standard handler mounts in Hono; 2 packages and 8.6 MB instead of 92 and 17 MB; current spec line.
- Negative: Apache-2.0 instead of MIT (compatible; keep its license file in the image); v2 has no authorization server (ADR 0014).
- Revisit when: a target client cannot speak to the v2 handler.
