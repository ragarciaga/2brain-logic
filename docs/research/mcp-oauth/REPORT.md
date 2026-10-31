# Benchmark: OAuth 2.1 for the remote MCP endpoint
Date: 2026-10-31  |  Decision needed for: docs/specs/02-mcp-server/

Brief written before any run: [BRIEF.md](BRIEF.md). Raw results: [results/](results/).
Machine: Linux container, Node v22.22.0 (the target is Node 24; no Node 24 here), everything on
127.0.0.1, no accounts, no paid calls. The owner passphrase is random per run and never written.

## Use case
One owner per install exposes `/mcp` (Streamable HTTP) on the public internet. claude.ai and
ChatGPT connectors and CLI clients (Claude Code, Codex) discover OAuth from a 401, register
dynamically, run authorization code + PKCE S256, refresh, and call tools. The owner proves
identity at the authorize step with a passphrase. Limits: 512 MB container next to n8n, no extra
server (no IdP), installable by a third party from a README.

## Candidates
| Name | Version | License | Last release | Stack fit |
|---|---|---|---|---|
| A. `@modelcontextprotocol/sdk` server auth (`mcpAuthRouter`, `OAuthServerProvider`, `requireBearerAuth`) + `WebStandardStreamableHTTPServerTransport` | 1.32.2 (pinned in AGENTS.md) | MIT | 2026-10-23 | Auth router, handlers and `requireBearerAuth` are Express only (`provider.authorize` receives an Express `Response`). The transport has a web-standard variant that mounts in Hono. Express 5.3.0 is a hard dependency |
| B. `@hono/mcp` (`mcpAuthRouter`, `bearerAuth`, `StreamableHTTPTransport`) | 0.3.5 | MIT | 2026-10-28 (11 releases since 2025-12) | Hono native. Peers: `@modelcontextprotocol/sdk ^1.29.0` (v1 only), `hono-rate-limiter ^0.5.4`, zod. Reuses the SDK v1 types and error classes, so Express still gets installed |
| C1. Hand-rolled AS in Hono (c-handrolled/as.mjs) + SDK 1.32.2 web-standard transport | n/a | ours (MIT) | n/a | Hono native. Express installed through the SDK but never loaded |
| C2. Same hand-rolled AS + `@modelcontextprotocol/server` (SDK v2: `createMcpHandler`, web-standard `requireBearerAuth`) | 2.4.0 | Apache-2.0 | 2026-10-23 (v2.0.0 was 2026-07-27) | Hono native, web-standard Request/Response, no Express |

Weekly downloads: not visible (the sandbox proxy refuses api.npmjs.org).

What really exists in npm, versus the assumption:
- `@modelcontextprotocol/sdk` 1.32.2 exists, but its README says it is the v1.x maintenance line:
  it implements the MCP spec up to 2025-11-25, the 2026-07-28 spec is only in v2, and v1 gets bug
  fixes and security updates "for at least six months after the v2 release (2026-07-27)", so
  about until 2027-01-27.
- SDK v2 ships as separate packages: `@modelcontextprotocol/server` 2.4.0, `client` 2.4.0,
  `hono` 2.0.2, `node` 2.1.2, `express` 2.0.2 (all Apache-2.0).
- SDK v2 has no authorization server. `mcpAuthRouter`, `OAuthServerProvider` and
  `ProxyOAuthServerProvider` are gone. Only resource server helpers are left (`requireBearerAuth`,
  `verifyBearerToken`, `oauthMetadataResponse`, `getOAuthProtectedResourceMetadataUrl`), and the
  Express package keeps only `mcpAuthMetadataRouter` and `requireBearerAuth`.
- `@modelcontextprotocol/hono` 2.0.2 only has `createMcpHonoApp` plus host and origin validation
  middleware. It has no auth.
- `@hono/mcp` 0.3.5 exists and has real auth support (a Hono port of the v1 router), but it
  requires SDK v1.

## Criteria and weights
Fixed in BRIEF.md before running. Each is scored 1 to 5 and weighted to a total of 100.

| Criterion | Weight | What counts |
|---|---|---|
| Security fit | 30 | Hard cases pass, RFC behavior, rate limiting, secret handling, attack surface |
| Works with claude.ai/ChatGPT style flow | 25 | Test steps passed across public (CLI) and confidential (web) clients |
| Stack fit with Hono | 20 | Mounts in Hono without bridges; web-standard |
| Memory and dependencies | 15 | RSS, packages, install size, Express |
| Maintenance | 10 | Release line status, who maintains the code |

## Test set
Every candidate runs the same script (shared/flow.mjs). The happy path uses the SDK's own client
OAuth (`StreamableHTTPClientTransport` + `authProvider`, which is what SDK-based CLIs run): 401,
discovery, DCR, PKCE, simulated owner form, `finishAuth`, `tools/call ping`. The rest runs on
fetch. Test-only tokens with a chosen expiry and audience come from a `/__test/mint` route that
exists only when `SPIKE_TEST=1`.

- S1-S2: 401 with `WWW-Authenticate: resource_metadata`; RFC 9728 document at that URL; RFC 8414
  document.
- S3-S7: SDK client discovery + DCR (public client, loopback redirect); wrong passphrase
  refused; code returned; code exchange; code reuse refused; ping; 100 pings and then RSS.
- S8: refresh, refreshed token works, old refresh token refused (rotation), reuse revokes the
  token family.
- W1-W4 (claude.ai or ChatGPT style): a confidential client with
  `https://claude.ai/api/mcp/auth_callback`, using `client_secret_post` and `client_secret_basic`
  (the RFC 7591 default). H1: neither authorize nor token sends `resource`, and the token must
  still work on `/mcp`.
- S9: RFC 7009 revoke (form-encoded), then the revoked access token and its refresh token are
  refused.
- S10: expired, wrong-audience and garbage tokens are refused; a valid minted token is accepted
  as a control.
- H2a: DCR with redirect `https://evil.example.net/cb`. H2b: authorize asks for a redirect on a
  different host than the one registered (must be a 400 with no redirect). H2c: loopback on
  another port is allowed (RFC 8252).
- H3: PKCE `plain`, missing challenge, and a wrong verifier are all refused. H1b: authorize for
  another resource is refused. H4: a scope the client did not register (informational).
  H5: the sign-in locks after 5 wrong passphrases.
- Extra: shared/memprobe.mjs checks RSS after 100, 1000 and 5000 calls. shared/v2client.mjs checks
  that a 2026-era client (SDK v2 client 2.4.0) can call each server.

The owner store, login page, redirect allowlist and token rules are the same code for every
candidate (shared/provider.mjs for A and B, c-handrolled/as.mjs for C). So the differences below
come from the libraries, not from different policies.

## Results
| Metric | A sdk 1.32.2 | B @hono/mcp 0.3.5 | C1 hand-rolled + sdk v1 | C2 hand-rolled + sdk v2 |
|---|---|---|---|---|
| Steps passed | 36/37 | 31/37 | 38/38 | 38/38 |
| Lines written (non-blank, non-comment) | 159 (server 41, provider 101, Hono bearer gate 17) | 142 (server 41, provider 101) | 172 (server 20, AS 135, gate 17) | 156 (server 21, AS 135) |
| Common code on top, all candidates (scrypt owner check, login page, redirect policy) | 39 | 39 | 39 | 39 |
| Server RSS idle / after 100 calls (flow run) | 102 / 132 MB | 83 / 110 MB | 85 / 112 MB | 81 / 108 MB |
| RSS after 100 / 1000 / 5000 calls (memprobe) | 108 / 138 / 180 MB | 89 / 124 / 156 MB | 94 / 131 / 167 MB | 91 / 124 / 167 MB |
| Same with `--max-old-space-size=64` | 106 / 118 / 120 MB | not run | not run | 90 / 110 / 110 MB |
| 100 tool calls, wall time | 318 ms | 284 ms | 391 ms | 300 ms |
| Cold start to first 200, median of 5 | 423 ms | 295 ms | 364 ms | 275 ms |
| node_modules size (app baseline hono + node-server + zod = 12.4 MB) | 29.3 MB | 29.6 MB | 29.3 MB | 21.0 MB |
| Packages installed (baseline 3) | 95 | 97 | 95 | 5 |
| Express pulled in | yes (5.3.0, plus cors, express-rate-limit, raw-body, ajv) | yes (through the SDK peer) | yes (installed, never loaded) | no |
| `npm audit` | 0 vulnerabilities | 0 | 0 | 0 |
| SDK v2 client (2026 era) can call ping | yes | yes | yes | yes |

Memory: RSS grows with an uncapped heap and levels off near 110-120 MB with a 64 MB old-space
cap, so this is lazy GC, not a leak. Every option fits the 512 MB limit. In production, set
`--max-old-space-size` (for example 192) so V8 stays well inside the container.

## Data completeness
| Field / capability | A | B | C1 / C2 |
|---|---|---|---|
| RFC 8414 AS metadata | yes | yes | yes |
| RFC 9728 PRM at the URL named in `WWW-Authenticate` | yes (path-aware `/.well-known/oauth-protected-resource/mcp`) | no: the header points to `/.well-known/oauth-protected-resource`, which returns 404 (the router serves only the path-aware URL) | yes (both URLs) |
| `resource_metadata` on 401 for expired/invalid tokens | yes (our gate) | no (`error="invalid_token"` only); `error="Unauthorized"` on a missing token is not an RFC 6750 code | yes (C1 our gate, C2 SDK v2) |
| `token_endpoint_auth_methods_supported` | `client_secret_post`, `none` | `client_secret_post` only | `none`, `client_secret_post`, `client_secret_basic` |
| `client_secret_basic` at /token | no (DCR still accepts the method and issues a secret, then /token answers `invalid_request`) | no (same) | yes |
| RFC 7009 revoke, form-encoded | yes | no: 500 `server_error` (the handler parses JSON after the client middleware parsed the form) | yes |
| PKCE S256 only, plain refused | yes | yes | yes |
| Redirect exact match + RFC 8252 loopback port | yes | yes | yes |
| Redirect host policy at DCR | none in the library (provider code) | none (provider code) | yes (built in) |
| Audience binding (RFC 8707) | provider + gate code | provider + verifyToken code | built in; C2 checks it with the SDK v2 `expectedResource` |
| Rate limiting | built in (express-rate-limit) | built in (hono-rate-limiter) | none besides 5 tries per sign-in and a cap of 50 clients |
| Client ID Metadata Documents (CIMD, preferred in the 2025-11-25 spec) | no | no | no |
| MCP spec level of the transport | up to 2025-11-25 | up to 2025-11-25 (SDK v1 types) | C1 2025-11-25; C2 2026-07-28 with a stateless 2025 fallback |

## Failures observed
- A, W3-basic: `400 invalid_request` with a raw Zod issue list for `client_id`. The v1
  `authenticateClient` reads only `client_id` and `client_secret` from the body. A client that
  registers without `token_endpoint_auth_method` gets the RFC 7591 default
  (`client_secret_basic`) and can never redeem its code. Error descriptions also send raw Zod
  JSON to clients (H3a shows the same).
- A, integration: the router only mounts in Express. The spike bridges Hono to an inner Express
  app through `c.env.incoming/outgoing` and `RESPONSE_ALREADY_SENT`. That ties the service to
  `@hono/node-server` and imports `express`, which is not a direct dependency.
  `requireBearerAuth` is Express only too, so a 17-line Hono gate was still needed.
- A, rate limit behind a proxy: 25 DCR calls with no `X-Forwarded-For` header gave `201x20 429x5`.
  With any `X-Forwarded-For` they gave `429x25` (keyed by socket IP, `trust proxy` off). Behind a
  reverse proxy, every client shares one bucket, so 20 registrations an hour from anyone block
  claude.ai too. The installer would have to configure `trust proxy` on an Express app they
  never see.
- B, S2a: `WWW-Authenticate ... resource_metadata="http://127.0.0.1:PORT/.well-known/oauth-protected-resource"`
  returns 404. The SDK client recovered, but it dropped `resource` from the authorize URL
  (`resource=null`). A client that follows only the header fails discovery.
- B, S9a-c: `/revoke` with the RFC 7009 form body returns `500 {"error":"server_error"}`, and the
  token stays valid (S9b got 200, S9c refresh still worked).
- B, W3-basic: same as A.
- B, H4: authorize with `scope=mcp` for a client registered without scopes redirects with
  `invalid_scope`. That is stricter than A. It is harmless only while no scopes are advertised.
- B, rate limit: 25 DCR calls with no forwarded header gave `201x25` (the limiter skips requests
  with no forwarded header). 25 calls with a rotating `X-Forwarded-For` gave `201x25` (the key is
  the leftmost, spoofable value). Client secrets are compared with `!==`, not in constant time.
- C1/C2: no step failed. Risk: all 135 lines are ours and nobody has reviewed them outside this
  spike.
- Library defaults for the hard cases: neither the SDK v1 DCR handler nor the `@hono/mcp` one
  restricts redirect hosts. H2a passed for A and B only because the shared provider rejects the
  host in `registerClient`. Without that check, open DCR lets anyone register
  `https://evil.example.net/cb` and send the owner a real sign-in link that delivers the code to
  the attacker. The consent page shows the redirect host in every candidate.
- Not tested: real claude.ai, ChatGPT, Codex or Claude Code against a public HTTPS URL (no
  accounts, by constraint). The spikes copy those clients' known shapes: loopback public clients,
  https confidential clients, no `resource` parameter.

## Recommendation
Weighted scores (score x weight / 5):

| Criterion (weight) | A | B | C1 | C2 |
|---|---|---|---|---|
| Security fit (30) | 3 -> 18 | 2 -> 12 | 4 -> 24 | 4 -> 24 |
| claude.ai/ChatGPT style flow (25) | 4 -> 20 | 2 -> 10 | 5 -> 25 | 5 -> 25 |
| Stack fit with Hono (20) | 2 -> 8 | 5 -> 20 | 4 -> 16 | 5 -> 20 |
| Memory and dependencies (15) | 2 -> 6 | 2 -> 6 | 2 -> 6 | 5 -> 15 |
| Maintenance (10) | 2 -> 4 | 2 -> 4 | 2 -> 4 | 4 -> 8 |
| Total (100) | 56 | 52 | 75 | 92 |

C2 wins: a hand-rolled single-owner authorization server in Hono plus the MCP SDK v2 server
(`@modelcontextprotocol/server` 2.4.0), because:
- Security (30): it passed every hard case, accepts `client_secret_basic`, and compares in
  constant time. It also avoids the Express bridge and the rate limiters that break behind a
  proxy.
- Flow (25): it passed all 38 steps (as did C1).
- Stack fit (20): it is web-standard end to end, so it fits Hono with no Express.
- Memory and dependencies (15): it adds 2 packages and 8.6 MB to the app instead of 92 packages
  and 17 MB.
- Maintenance (10): it sits on the current SDK line, not the one losing support around 2027-01.

The libraries do not save real work. With A or B, the integrator still writes about 100 lines of
provider code: storage, owner login, issuing tokens, the audience rule, and the redirect policy.
The library only replaces about 35 lines of request parsing.

Trade-offs accepted:
- About 135 lines of security-sensitive code that we own. It goes under `src/auth/**`, which is
  already a Sensitive path, needs the security reviewer and unit tests for every step above.
- We add our own small rate limiter.
- `@modelcontextprotocol/server` is Apache-2.0, unlike the MIT SDK v1. It is compatible with the
  MIT product; keep its license file in the image.
- AGENTS.md and the brief pin `@modelcontextprotocol/sdk` 1.32.2, so moving to v2 is a stack
  change that needs an ADR (tier C).
- If v1 is kept for now, C1 (same `as.mjs`, v1 transport) scored 75 and moves to v2 by changing
  about 10 lines of `server.mjs`.

Revisit if:
- a target client needs CIMD-only registration or OIDC discovery,
- the MCP SDK ships a maintained web-standard authorization server again,
- a second user per install becomes a requirement (docs/v2.md), or
- the security review finds the hand-rolled AS needs more than small fixes.

## What the winner lacks (to build in F2 or move to docs/v2.md)
1. Persistence. Clients and refresh tokens live in memory in the spike, so a restart breaks every
   connector. It needs an atomic JSON or SQLite file in a data volume, never in the vault repo.
   Store tokens hashed, as the spike does.
2. Rate limiting on `/register`, `/token`, `/authorize` and `/login`, keyed by the real client IP
   from one trusted proxy hop.
3. Client ID Metadata Documents (CIMD). Only DCR is supported. The SDK v1 client already uses CIMD
   when the AS advertises `client_id_metadata_document_supported`.
4. Scopes. Access is all or nothing: there is no read versus write split.
5. No `/.well-known/openid-configuration`. There is no consent memory, so the owner types the
   passphrase for every new client authorization.
6. Revoking the tokens already issued when a code is reused (an OAuth 2.1 SHOULD). Expiry and
   cleanup of unused registered clients.
7. Passphrase setup and rotation tooling (a CLI that prints `OWNER_PASSPHRASE_HASH`) and a lockout
   policy beyond 5 tries per sign-in.
8. Verification against the real clients (claude.ai, ChatGPT, Claude Code, Codex) over public
   HTTPS. This is an `rb:needs-local` step before the proxy route opens (ADR 0007).

## What a third-party installer must configure (winner)
- `PUBLIC_BASE_URL` (https). The issuer and resource come from it, never from the `Host` header.
- `OWNER_PASSPHRASE_HASH` (scrypt string from the CLI). Never the plain passphrase.
- Optional `ALLOWED_REDIRECT_HOSTS` (default `claude.ai,claude.com,chatgpt.com`; loopback is
  always allowed).
- A data volume for the auth store, TLS at the reverse proxy, and public routes for only `/mcp`,
  `/authorize`, `/login`, `/token`, `/register`, `/revoke` and `/.well-known/*`. The ingest API
  stays internal.
- A trusted proxy setting for the rate limiter.

## Decisions the F2 design must take
1. SDK line: the pinned `@modelcontextprotocol/sdk` 1.32.2 (maintenance until about 2027-01)
   versus `@modelcontextprotocol/server` 2.4.0 (ADR, AGENTS.md Stack, brief).
2. A built-in authorization server (recommended) versus a library.
3. Topology. Today `createApp` puts `ingestTokenAuth` on `*`, which would block OAuth: a separate
   Hono app on its own port for public MCP + OAuth (recommended) or route exemptions.
4. The auth store format and location, token lifetimes (spike: access 1 h, refresh 30 days
   rotating with family revocation), and opaque versus JWT tokens (spike: opaque, stored as
   SHA-256).
5. Missing `resource` policy: default to the single MCP URL (tested) and reject any other value.
6. The DCR redirect allowlist and how an owner extends it; supported client auth methods.
7. Owner authentication: a passphrase only, or a second factor later; attempt limits.
8. Scopes now or later; CIMD now or in docs/v2.md.
9. The heap cap for the container (`--max-old-space-size`).

## How to rerun
```bash
cd docs/research/mcp-oauth
for d in shared a-sdk b-hono-mcp c-handrolled c2-handrolled-v2 baseline; do (cd $d && npm ci); done
node shared/flow.mjs c2-handrolled-v2 48120
node shared/memprobe.mjs c2-handrolled-v2 48130
```
