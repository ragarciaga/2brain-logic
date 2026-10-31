# 0014. Built-in single-owner OAuth 2.1 authorization server

Status: accepted
Date: 2026-10-31
Related: docs/adr/0007-mcp-auth.md, docs/specs/02-mcp-server/, docs/research/mcp-oauth/REPORT.md
Approved by: the owner's standing instruction in the build session (2026-10-31), no cost involved

## Context
ADR 0007 requires OAuth 2.1 before the MCP endpoint is public and left the implementation to a benchmark. AI clients expect discovery from a 401, dynamic client registration, authorization code with PKCE S256 and refresh tokens. One owner per install, no extra server, installable from a README.

## Decision
We will build a small authorization server inside the service (Hono, about 135 lines in the spike): RFC 8414 and RFC 9728 discovery, RFC 7591 registration with a redirect host allowlist, authorize with an owner passphrase (scrypt hash in `OWNER_PASSPHRASE_HASH`), opaque tokens stored as SHA-256 hashes in a JSON file in a data volume, refresh rotation with grant revocation, RFC 7009 revoke and per-IP rate limits.

## Alternatives considered
| Option | Why rejected |
|---|---|
| SDK v1 auth router | Express only, `client_secret_basic` broken, proxy-unaware rate limiter (benchmark A) |
| `@hono/mcp` auth router | Wrong metadata URL, broken revoke, spoofable rate limiter (benchmark B) |
| External identity provider (Auth0, Keycloak, GitHub login) | An account or extra server per installer; Keycloak does not fit 512 MB |

## Consequences
- Positive: one process, no account, every OAuth rule tested in our suite.
- Negative: security code we own under `src/auth/**` (Sensitive path, security review on every change).
- Revisit when: a second user per install, scopes or CIMD-only clients become a requirement, or a maintained web-standard authorization server appears.
