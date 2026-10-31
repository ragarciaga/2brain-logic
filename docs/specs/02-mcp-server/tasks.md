# Tasks: MCP server with OAuth
Spec: docs/specs/02-mcp-server/  |  Status: draft

<!--
Field names and statuses stay in canonical English (parsed strictly by `rb tasks`; unknown keys
or statuses are errors). Statuses: todo, in-progress, in-review, done, blocked.
Builds on F1 (docs/specs/01-vault-core/): the write tools need the F1 create, dedupe and PATCH
paths, so T13 and T14 start after F1 is merged. Order: dependency and env, public app and
discovery, store and rate limits, registration and owner sign-in, tokens, the protected endpoint,
tools, packaging, then the manual check with real clients.
Every task under src/auth/** is tier C (Sensitive path).
-->

## T1: MCP SDK v2 dependency and public env vars
- Purpose: the service can load the public app configuration and refuses a bad one without echoing values
- Covers: R1.3
- Size: S
- Depends on: none
- Files: package.json, package-lock.json, src/config/env.ts, .env.example, README.md, tests/env.test.ts
- Verify: `npm test -- tests/env.test.ts`; `@modelcontextprotocol/server` 2.4.0 and dev `@modelcontextprotocol/client` 2.4.0 pinned exactly; `@modelcontextprotocol/sdk` absent; with `PUBLIC_BASE_URL` unset the public settings are absent; an `http://example.com` URL, a missing or malformed `OWNER_PASSPHRASE_HASH`, a non-numeric `MCP_PORT` or `TRUST_PROXY_HOPS` each throw an error naming the variable and not containing its value; `http://127.0.0.1:3001` and `https://brain.example.com` pass; defaults `MCP_PORT` 3001, `AUTH_STORE_DIR` `/data/auth`, `TRUST_PROXY_HOPS` 0, `ALLOWED_REDIRECT_HOSTS` claude.ai, claude.com, chatgpt.com
- Issue:
- Status: todo

## T2: Public app router and startup wiring
- Purpose: a second app serves only the public routes, starts only when configured, and never exposes ingest
- Covers: R1.1, R1.2, R1.4
- Size: S
- Depends on: T1
- Files: src/mcp/app.ts, src/index.ts, tests/mcp-app.test.ts, tests/start.test.ts
- Verify: `npm test -- tests/mcp-app.test.ts tests/start.test.ts`; built entry with `PUBLIC_BASE_URL` set listens on `MCP_PORT` and answers 404 for `POST /notes`, `PATCH /notes`, `POST /notes/archive`, `GET /health` and an unknown path; without it no second port opens and the log has one `mcp disabled` line; with an invalid public env the process exits 1 naming the variable; a request with a forged `Host` and `X-Forwarded-Host` gets URLs built from `PUBLIC_BASE_URL` only
- Issue:
- Status: todo

## T3: Discovery metadata
- Purpose: clients find the resource and authorization server from the published documents
- Covers: R2.2, R2.3
- Size: S
- Depends on: T2
- Files: src/auth/oauth/metadata.ts, src/mcp/app.ts, tests/oauth-metadata.test.ts
- Verify: `npm test -- tests/oauth-metadata.test.ts`; both RFC 9728 paths return the same document with `resource` `<PUBLIC_BASE_URL>/mcp` and the authorization server; the RFC 8414 document lists issuer, the four endpoints, `response_types_supported` `["code"]`, `code_challenge_methods_supported` `["S256"]`, `grant_types_supported` with both grants, and the three client auth methods; all URLs start with `PUBLIC_BASE_URL`
- Issue:
- Status: todo

## T4: Auth store
- Purpose: clients and grants survive a restart and no token or secret is stored in clear
- Covers: R5.5, R5.6
- Size: M
- Depends on: T1
- Files: src/auth/oauth/store.ts, tests/auth-store.test.ts
- Verify: `npm test -- tests/auth-store.test.ts`; a saved client and grant are found by hash after reopening the store from disk; the file contains no raw token or secret (grep for each issued value); writes go to a temp file then rename (a crash simulated between write and rename leaves the old file valid); concurrent saves are serialized; expired grants are removed on write; an invalid JSON or wrong `version` file throws an error naming the file and not its content
- Issue:
- Status: todo

## T5: Rate limiter and client IP
- Purpose: public endpoints throttle per real client IP and cannot be fooled by a forged forwarded header
- Covers: R7.1, R7.2
- Size: S
- Depends on: T1
- Files: src/auth/rate-limit.ts, tests/rate-limit.test.ts
- Verify: `npm test -- tests/rate-limit.test.ts`; with an injectable clock, the 11th registration in an hour, the 61st token request in a minute and the 11th sign-in in a minute from one IP get 429 with `Retry-After`; another IP is not affected; the window resets; with `TRUST_PROXY_HOPS` 0 the socket IP is used even when `X-Forwarded-For` is present; with 1 the rightmost entry is used and a rotating leftmost value does not change the key
- Issue:
- Status: todo

## T6: Dynamic client registration
- Purpose: AI clients register themselves, only with allowed redirect hosts, within a fixed cap
- Covers: R3.1, R3.2, R3.3, R3.4
- Size: M
- Depends on: T3, T4, T5
- Files: src/auth/oauth/register.ts, src/mcp/app.ts, tests/oauth-register.test.ts
- Verify: `npm test -- tests/oauth-register.test.ts`; a public client with a loopback redirect gets 201 and no secret; a confidential client with `https://claude.ai/api/mcp/auth_callback` gets a secret, stored only as its hash; `https://evil.example.net/cb`, `http://claude.ai/cb`, a `javascript:` URI and a mix of one good and one bad URI each give 400 `invalid_redirect_uri` and store nothing; the 51st client gives 400 `invalid_client_metadata`; error descriptions are fixed strings
- Issue:
- Status: todo

## T7: Owner passphrase and hash-passphrase CLI
- Purpose: the owner sets a hashed passphrase with one command and sign-in compares it safely
- Covers: R10.1, R10.2
- Size: S
- Depends on: T1
- Files: src/auth/owner.ts, src/cli.ts, tests/owner.test.ts, tests/cli.integration.test.ts
- Verify: `npm test -- tests/owner.test.ts tests/cli.integration.test.ts`; `hash-passphrase` with a 12-character passphrase on stdin prints one line accepted by the env loader and by `verifyPassphrase`; the same passphrase gives a different hash each run (random salt); an 11-character passphrase exits 1 with no hash; `verifyPassphrase` uses `timingSafeEqual` and rejects a wrong passphrase and a malformed hash
- Issue:
- Status: todo

## T8: Authorize request checks and sign-in page
- Purpose: only well-formed requests from registered clients reach the sign-in page, and the page cannot be framed or cached
- Covers: R4.1, R4.2, R4.3, R4.6
- Size: M
- Depends on: T6, T7
- Files: src/auth/oauth/authorize.ts, src/mcp/app.ts, tests/oauth-authorize.test.ts
- Verify: `npm test -- tests/oauth-authorize.test.ts`; a valid request shows a page naming the client and the redirect host, with `Cache-Control: no-store` and `X-Frame-Options: DENY`; a loopback redirect with another port is accepted; an unknown client and an unregistered redirect give a 400 page and no `Location` header; missing PKCE, `plain`, and `resource` for another URL redirect with `invalid_request` or `invalid_target` and the `state`; a missing `resource` is accepted
- Issue:
- Status: todo

## T9: Owner sign-in and lockout
- Purpose: the right passphrase issues a single-use code; guessing is locked out
- Covers: R4.4, R4.5
- Size: S
- Depends on: T8
- Files: src/auth/oauth/authorize.ts, src/auth/owner.ts, tests/oauth-signin.test.ts
- Verify: `npm test -- tests/oauth-signin.test.ts`; the right passphrase redirects with `code` and `state`; a POST with a foreign `Origin` is refused; a wrong passphrase shows the page again with a generic error; the 6th attempt within 15 minutes from one IP gets 429 even with the right passphrase, and works again after 15 minutes (injected clock); no log line or page contains the passphrase
- Issue:
- Status: todo

## T10: Token and revoke endpoints
- Purpose: clients exchange codes, refresh with rotation, and revoke, with reuse detection
- Covers: R5.1, R5.2, R5.3, R5.4
- Size: M
- Depends on: T9
- Files: src/auth/oauth/token.ts, src/mcp/app.ts, tests/oauth-token.test.ts
- Verify: `npm test -- tests/oauth-token.test.ts`; a valid exchange returns a 1 hour access token and a 30 day refresh token bound to the resource; `client_secret_post`, `client_secret_basic` and `none` all work for their clients; an expired code (61 s), a reused code and a wrong verifier give `invalid_grant`, and the reused code also revokes its tokens; a refresh rotates and the old refresh token then revokes the grant; RFC 7009 revoke (form body) returns 200 for known and unknown tokens and the revoked tokens stop working; error bodies carry fixed descriptions
- Issue:
- Status: todo

## T11: Protected MCP endpoint
- Purpose: `/mcp` serves MCP only to valid tokens for this resource and refuses foreign origins
- Covers: R2.1, R6.1, R6.2, R6.3
- Size: M
- Depends on: T10
- Files: src/auth/oauth/bearer.ts, src/mcp/server.ts, src/mcp/app.ts, tests/mcp-endpoint.test.ts
- Verify: `npm test -- tests/mcp-endpoint.test.ts`; no token gives 401 with the exact `WWW-Authenticate` value; expired, revoked, unknown and wrong-audience tokens give 401 with `error="invalid_token"`; a valid token lists the tools through the SDK v2 client; an `Origin` of `https://evil.example.net` gives 403 and one of `https://claude.ai` passes
- Issue:
- Status: todo

## T12: Read tools: search, read, recent
- Purpose: the owner finds and reads notes from any client, fast and without leaving the vault
- Covers: R8.1, R8.2, R8.3, R8.4
- Size: M
- Depends on: T11
- Files: src/mcp/tools/read.ts, src/mcp/server.ts, src/git/index.ts, tests/mcp-read-tools.test.ts
- Verify: `npm test -- tests/mcp-read-tools.test.ts`; `search` finds a phrase case-insensitively, treats `.*` and `-e` as literal text, skips `.git` and the archive folder, caps results at `limit`; `read` returns frontmatter and body and gives `unsafe_path` for `../x.md` and a symlink out of the vault and `note_not_found` for a missing path; `recent` lists notes committed in the window newest first; a generated 10,000-note fixture is searched in under 2 s
- Issue:
- Status: todo

## T13: Write tools: save_note and save_recipe
- Purpose: notes and recipes saved from a client go through the same validated, scrubbed write path as ingest
- Covers: R9.1, R9.2, R9.4, R9.5
- Size: M
- Depends on: T11
- Files: src/mcp/tools/write.ts, src/mcp/server.ts, src/server/errors.ts, src/server/app.ts, tests/mcp-write-tools.test.ts
- Verify: `npm test -- tests/mcp-write-tools.test.ts tests/app.test.ts`; `save_note` commits and pushes a valid note and returns `path`, `commit` and `redactions`; a secret in the body is redacted; invalid frontmatter, wrong folder, duplicate source and an existing path give the same error codes and detail fields as `POST /notes`, with no request value in the result or the logs; `save_recipe` writes `recipes/<slug>.md` with the recipe type and `## Problem` and `## Solution`; the tool list has no delete, move or archive tool; the ingest routes use the shared error mapping with unchanged responses
- Issue:
- Status: todo

## T14: update_properties tool
- Purpose: a client can change a note's properties through the F1 update path
- Covers: R9.3
- Size: S
- Depends on: T13
- Files: src/mcp/tools/write.ts, tests/mcp-write-tools.test.ts
- Verify: `npm test -- tests/mcp-write-tools.test.ts`; `update_properties` merges properties, validates, commits and returns the patch outcome; a missing note gives `note_not_found`; an unchanged result gives `unchanged: true` and no commit; the body is never modified
- Issue:
- Status: todo

## T15: OAuth flow end to end from the built entry point
- Purpose: the whole connector journey works from a real process and survives a restart
- Covers: R4.1, R4.4, R5.5, R6.1
- Size: M
- Depends on: T12, T13
- Files: tests/mcp-flow.integration.test.ts, tests/helpers/oauth-client.ts
- Verify: `npm test -- tests/mcp-flow.integration.test.ts`; against `dist/index.js` with a temp store and fixture vault: 401, discovery, registration, authorize with the passphrase, code exchange, `tools/call search` and `save_note` with the SDK v2 client, refresh, process restart, the refreshed token still works, revoke, then 401
- Issue:
- Status: todo

## T16: Container settings for the public app
- Purpose: the image and compose file run the public app within the memory limit with a persistent auth store
- Covers: R5.5, R1.1
- Size: S
- Depends on: T2, T4
- Files: Dockerfile, compose.yaml, tests/compose.test.ts, README.md
- Verify: `npm test -- tests/compose.test.ts`; the final stage sets `NODE_OPTIONS=--max-old-space-size=192`; compose mounts a named volume at `/data/auth`, exposes `MCP_PORT` only on the proxy network and never publishes the ingest port; the `docker-build` CI check is green
- Issue:
- Status: todo

## T17: Connect the real clients
- Purpose: the owner confirms claude.ai and a CLI client can connect, sign in and use the tools
- Covers: R11.1, R11.2
- Size: S
- Depends on: T15, T16
- Files: README.md, docs/GUIDE-mcp.md
- Verify: `[manual]` (needs a public HTTPS URL and the owner's accounts): the guide's steps for claude.ai (custom connector), Claude Code (`claude mcp add --transport http`) and Codex or ChatGPT are followed by the owner, and `search` and `save_note` work; the issue is labelled `rb:needs-local` with the exact steps
- Issue:
- Status: todo
