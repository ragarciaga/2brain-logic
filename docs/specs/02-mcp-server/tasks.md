# Tasks: MCP server with OAuth
Spec: docs/specs/02-mcp-server/  |  Status: approved  |  Converged: 2026-10-31, 1 round, not converged (round 1 rewrites and the T17 split applied from their reviewers, no second round)

<!--
Field names and statuses stay in canonical English (parsed strictly by `rb tasks`; unknown keys
or statuses are errors). Statuses: todo, in-progress, in-review, done, blocked.
Builds on F1 (docs/specs/01-vault-core/): the write tools need the F1 create, dedupe and PATCH
paths, so T13 and T14 start after F1 is merged. Order: dependency and env, public app and
discovery, store and rate limits, registration and owner sign-in, tokens, the protected endpoint,
tools, packaging, then the manual check with real clients.
Every task under src/auth/** is tier C (Sensitive path). Route rate limits (R7.1) are wired by the task that owns each route (T6 register, T9 sign-in, T10 token); T5 builds the limiter.
The owner passphrase hash format is `scrypt$<N>$<r>$<p>$<salt base64url>$<key base64url>` (T1 checks it, T7 emits and verifies it).
-->

## T1: MCP SDK v2 dependency and public env vars
- Purpose: the service can load the public app configuration and refuses a bad one without echoing values
- Covers: R1.3
- Size: S
- Depends on: none
- Files: package.json, package-lock.json, src/config/env.ts, .env.example, README.md, tests/env.test.ts
- Verify: `npm test -- tests/env.test.ts`; `@modelcontextprotocol/server` 2.4.0 (dependencies) and `@modelcontextprotocol/client` 2.4.0 (devDependencies) are exact versions, and `@modelcontextprotocol/sdk` is absent from package.json and package-lock.json; the existing `loadEnv` assertions still pass (the public settings are a separate optional part of the result, absent when `PUBLIC_BASE_URL` is unset, and then a missing or malformed `OWNER_PASSPHRASE_HASH` is not an error); with `PUBLIC_BASE_URL` set, an `http://example.com` URL, a missing `OWNER_PASSPHRASE_HASH`, a hash not matching `scrypt$<N>$<r>$<p>$<salt base64url>$<key base64url>` with positive integers, a non-numeric `MCP_PORT` and a non-integer or negative `TRUST_PROXY_HOPS` each throw an error naming the variable and not containing its value (marker-value test); `http://127.0.0.1:3001`, `http://localhost:3001` and `https://brain.example.com` pass with a well-formed hash; defaults `MCP_PORT` 3001, `AUTH_STORE_DIR` `/data/auth`, `TRUST_PROXY_HOPS` 0, `ALLOWED_REDIRECT_HOSTS` claude.ai, claude.com, chatgpt.com (a custom comma-separated value is split and trimmed); a test reads `.env.example` and finds all six names
- Issue: #44
- Status: done

## T2: Public app router and startup wiring
- Purpose: a second app serves only the public routes, starts only when configured, and never exposes ingest
- Covers: R1.1, R1.2, R1.3, R1.4
- Size: S
- Depends on: T1
- Files: src/mcp/app.ts, src/index.ts, tests/mcp-app.test.ts, tests/start.test.ts
- Verify: `npm test -- tests/mcp-app.test.ts tests/start.test.ts`; the built entry with `PUBLIC_BASE_URL` set listens on `MCP_PORT`, bound to `HOST`, and answers 404 (no token needed, never 401) for `POST /notes`, `PATCH /notes`, `POST /notes/archive`, `GET /health` and an unknown path, while the ingest port still serves `/health` with 200; without `PUBLIC_BASE_URL` no second port opens and the log has exactly one `mcp disabled` line; with `PUBLIC_BASE_URL` `http://example.com` or with `OWNER_PASSPHRASE_HASH` missing the process exits 1, the message names the variable and does not contain its value; unit: `createPublicApp` exposes one URL builder (issuer, resource `<PUBLIC_BASE_URL>/mcp`, protected-resource metadata URL) whose only input is the configured base URL, and its output is unchanged for requests with a forged `Host` and `X-Forwarded-Host`; the existing start.test.ts helpers are reused
- Issue: #45
- Status: done

## T3: Discovery metadata
- Purpose: clients find the resource and authorization server from the published documents
- Covers: R2.2, R2.3
- Size: S
- Depends on: T2
- Files: src/auth/oauth/metadata.ts, src/mcp/app.ts, tests/oauth-metadata.test.ts
- Verify: `npm test -- tests/oauth-metadata.test.ts`; both RFC 9728 paths return the same document with `resource` `<PUBLIC_BASE_URL>/mcp` and the authorization server; the RFC 8414 document lists issuer, the four endpoints, `response_types_supported` `["code"]`, `code_challenge_methods_supported` `["S256"]`, `grant_types_supported` with both grants, and the three client auth methods; every URL starts with `PUBLIC_BASE_URL`, also for requests sent with a forged `Host` and `X-Forwarded-Host`
- Issue: #46
- Status: done

## T4: Auth store
- Purpose: clients and grants survive a restart, no token or secret is stored in clear, and a bad store file stops startup
- Covers: R5.5, R5.6
- Size: M
- Depends on: T2
- Files: src/auth/oauth/store.ts, src/index.ts, tests/auth-store.test.ts, tests/start.test.ts
- Verify: `npm test -- tests/auth-store.test.ts tests/start.test.ts`; a saved client and grant are found by hash after reopening the store from disk; the file contains no raw token or secret (grep for each issued value); writes go to a temp file then rename (a crash simulated between write and rename leaves the old file valid, and a failed write returns `server_error` and keeps the old data); concurrent saves are serialized; expired grants are removed on write; an invalid JSON or wrong `version` file throws an error naming the file and not its content; the built entry with `PUBLIC_BASE_URL` set and an invalid `auth.json` in `AUTH_STORE_DIR` exits 1, the output names the file and does not contain its content; a missing file starts with an empty store
- Issue: #47
- Status: done

## T5: Rate limiter and client IP
- Purpose: public endpoints can throttle per real client IP, which a forged forwarded header cannot change
- Covers: R7.1, R7.2
- Size: S
- Depends on: T1
- Files: src/auth/rate-limit.ts, tests/rate-limit.test.ts
- Verify: `npm test -- tests/rate-limit.test.ts`; the module exports a Hono middleware factory `rateLimit(rule, deps)` (injectable clock and `trustProxyHops`) and a `RATE_RULES` table with `register` 10 per hour, `token` 60 per minute and `signin` 10 per minute; on a probe Hono app with the injected clock, the 11th `register`, the 61st `token` and the 11th `signin` request from one IP within the window each get 429 with `Retry-After` set to the seconds left (positive integer) while the earlier ones pass; another IP is not affected and rules do not share a bucket; the window resets after it elapses; with `TRUST_PROXY_HOPS` 0 the socket IP is used even when `X-Forwarded-For` is present; with 1 the rightmost entry is used and a rotating leftmost value does not change the key
- Issue: #48
- Status: done

## T6: Dynamic client registration
- Purpose: AI clients register themselves, only with allowed redirect hosts, within a fixed cap and a per-IP rate limit
- Covers: R3.1, R3.2, R3.3, R3.4
- Size: M
- Depends on: T2, T4, T5
- Files: src/auth/oauth/register.ts, src/mcp/app.ts, tests/oauth-register.test.ts
- Verify: `npm test -- tests/oauth-register.test.ts`; a public client (`none`) with `http://127.0.0.1:<port>/cb`, `http://localhost:<port>/cb` or `http://[::1]:<port>/cb` gets 201 and no secret; a confidential client with `https://claude.ai/api/mcp/auth_callback` (and on `claude.com` and `chatgpt.com`) gets a `client_secret` stored only as its SHA-256 hash (the store file holds no raw secret); a host set through `ALLOWED_REDIRECT_HOSTS` is accepted and a default host removed from it is refused; `https://evil.example.net/cb`, `http://claude.ai/cb`, a `javascript:` URI and a mix of one good and one bad URI each give 400 `invalid_redirect_uri` and store nothing; invalid JSON, a missing or empty `redirect_uris` and an unknown `token_endpoint_auth_method` give 400 `invalid_client_metadata` with a fixed description (no Zod issue text, no request value); with 49 clients stored the 50th registers and the 51st gives 400 `invalid_client_metadata` naming the limit and stores nothing, unless a client without a grant is more than 24 hours old, in which case the oldest such client is removed and the 51st is stored (R3.4); through the route, the 11th registration within an hour from one IP gets 429 with `Retry-After` and stores nothing, and another IP is not affected (R7.1)
- Issue: #49
- Status: done

## T7: Owner passphrase and hash-passphrase CLI
- Purpose: the owner sets a hashed passphrase with one command and sign-in compares it safely
- Covers: R10.1, R10.2
- Size: S
- Depends on: T1
- Files: src/auth/owner.ts, src/cli.ts, tests/owner.test.ts, tests/cli.integration.test.ts
- Verify: `npm test -- tests/owner.test.ts tests/cli.integration.test.ts`; `hash-passphrase` with a 12-character passphrase on stdin (with and without a trailing newline, one newline stripped) prints one line in the `scrypt$<N>$<r>$<p>$<salt>$<key>` format accepted by the env loader and by `verifyPassphrase`; the same passphrase gives a different hash each run (random salt); an 11-character passphrase exits 1 with no hash; `verifyPassphrase` uses `timingSafeEqual`, passes an explicit `maxmem`, and rejects a wrong passphrase and a malformed hash; the existing `init-vault` tests stay green
- Issue: #50
- Status: done

## T8: Authorize request checks and sign-in page
- Purpose: only well-formed requests from registered clients reach the sign-in page, and the page cannot be framed, cached or used to inject markup
- Covers: R4.1, R4.2, R4.3, R4.6
- Size: M
- Depends on: T6
- Files: src/auth/oauth/authorize.ts, src/mcp/app.ts, tests/oauth-authorize.test.ts
- Verify: `npm test -- tests/oauth-authorize.test.ts`; a valid request shows a page naming the client and the redirect host, with `Cache-Control: no-store` and `X-Frame-Options: DENY`; the form has a relative `action`, `method="post"` and the request fields as hidden inputs; a client registered with the name `<script>alert(1)</script>` renders escaped; a loopback redirect with another port is accepted; an unknown client and an unregistered redirect give a 400 page and no `Location` header; missing PKCE, `plain`, and `resource` for another URL redirect with `invalid_request` or `invalid_target` and the `state`; a missing `resource` is accepted; the request checks are exported for reuse by the POST handler
- Issue: #51
- Status: done

## T9: Owner sign-in and lockout
- Purpose: the right passphrase issues a single-use code for a re-validated request; guessing is locked out
- Covers: R4.4, R4.5
- Size: S
- Depends on: T7, T8
- Files: src/auth/oauth/authorize.ts, src/auth/oauth/codes.ts, src/auth/owner.ts, src/mcp/app.ts, tests/oauth-signin.test.ts
- Verify: `npm test -- tests/oauth-signin.test.ts`; the right passphrase redirects to the registered `redirect_uri` with `code` and the client's `state`, and two sign-ins give different codes; the code is held in memory in src/auth/oauth/codes.ts (60 s expiry, injected clock) bound to client, redirect URI, challenge and resource; a POST whose client is unknown, whose `redirect_uri` is not registered, or whose PKCE or `resource` fields are invalid gets the same 400 page or redirect error as GET and issues no code, even with the right passphrase; a POST with a foreign `Origin` is refused and issues no code; a wrong passphrase shows the page again with a generic error and no `Location` header; after 5 wrong attempts within 15 minutes from one IP the 6th attempt gets 429 even with the right passphrase, another IP is not affected, and sign-in works again after 15 minutes; the 11th sign-in submission in a minute from one IP gets 429 with `Retry-After` (R7.1); no log line or page contains the passphrase
- Issue: #52
- Status: done

## T10: Token and revoke endpoints
- Purpose: clients exchange codes, refresh with rotation, and revoke, with reuse detection
- Covers: R5.1, R5.2, R5.3, R5.4
- Size: M
- Depends on: T9
- Files: src/auth/oauth/token.ts, src/auth/oauth/codes.ts, src/mcp/app.ts, tests/oauth-token.test.ts
- Verify: `npm test -- tests/oauth-token.test.ts` (injected clock); a valid exchange returns an opaque access token expiring in 1 hour and a refresh token expiring in 30 days, the stored grant has `resource` `<PUBLIC_BASE_URL>/mcp`, and the store holds only hashes of both; `client_secret_post`, `client_secret_basic` and `none` each work for a client registered with that method; a wrong or missing client secret gives 401 `invalid_client`; an expired code (61 s), a reused code, a wrong verifier, a `redirect_uri` different from the authorize request and a code issued to another client give 400 `invalid_grant`, and the reused code also marks its grant `revoked`; a refresh returns a new pair and the old refresh token used again gives `invalid_grant` and marks the grant `revoked` (the new refresh token then also fails); an expired refresh token (31 days) gives `invalid_grant`; RFC 7009 revoke (form body) of an access token and of a refresh token returns 200 and marks the grant `revoked`, an unknown token returns 200 and changes nothing, and a revoke from another client returns 200 and leaves the grant unrevoked; the 61st `POST /token` in a minute from one IP gets 429 with `Retry-After` (R7.1); every error body has a fixed `error_description` with no request value
- Issue: #53
- Status: done

## T11: Protected MCP endpoint
- Purpose: `/mcp` serves MCP only to valid tokens for this resource, refuses foreign origins, and is wired into startup
- Covers: R2.1, R6.1, R6.2, R6.3
- Size: M
- Depends on: T10
- Files: src/auth/oauth/bearer.ts, src/mcp/server.ts, src/mcp/app.ts, src/index.ts, tests/mcp-endpoint.test.ts
- Verify: `npm test -- tests/mcp-endpoint.test.ts` (grants seeded through the T4 store); no token and a non-Bearer `Authorization` value give 401 with exactly `WWW-Authenticate: Bearer resource_metadata="<PUBLIC_BASE_URL>/.well-known/oauth-protected-resource/mcp"` and no `error` parameter; expired, revoked, unknown and wrong-audience tokens give 401 with the same value plus `error="invalid_token"`; with a valid token the SDK v2 client connects and gets a JSON body (`Content-Type: application/json`, no event stream), and `tools/list` returns an array (empty until T12 and T13; `createMcpServer` takes the vault writer and config as parameters and exports the tool registry they add to); `Origin: https://evil.example.net` and `Origin: http://claude.ai` give 403 even with a valid token, while `https://claude.ai`, the `PUBLIC_BASE_URL` origin and no `Origin` pass; src/index.ts opens the store and mounts the MCP handler on the public app
- Issue: #54
- Status: done

## T12: Read tools: search, read, recent
- Purpose: the owner finds and reads notes from any client, fast and without leaving the vault, on the latest pulled commit
- Covers: R8.1, R8.2, R8.3, R8.4
- Size: M
- Depends on: T11
- Files: src/mcp/tools/read.ts, src/mcp/server.ts, src/git/index.ts, src/vault/write-note.ts, tests/mcp-read-tools.test.ts, tests/notes.integration.test.ts
- Verify: `npm test -- tests/mcp-read-tools.test.ts tests/notes.integration.test.ts`; `search` finds a phrase case-insensitively, treats `.*` and `-e` as literal text, skips `.git` and the configured archive folder, returns path, title and a line snippet, defaults `limit` to 20 and caps it at 50, rejects a `query` over 200 characters, and returns `search_timeout` on a forced timeout; `read` returns frontmatter and body and gives `unsafe_path` for `../x.md`, a path inside `.git` and a symlink out of the vault, and `note_not_found` for a missing path; `recent` lists notes committed within `days` newest first with path, title, type and date, excludes notes last committed before the window, defaults to 7 days and 20 results, caps `days` at 90 and `limit` at 50, and returns `git_failed` when git log fails; each tool pulls first through the writer's queue (a note pushed from a second clone is found without restart; a read issued during a write waits for it), and when the pull fails the result is returned with `stale: true`; the ingest write behavior is unchanged; a generated 10,000-note fixture is searched in under 2 s
- Issue: #55
- Status: todo

## T13: Write tools: save_note and save_recipe
- Purpose: notes and recipes saved from a client go through the same validated, scrubbed write path as ingest
- Covers: R9.1, R9.2, R9.4, R9.5
- Size: M
- Depends on: T12
- Files: src/mcp/tools/write.ts, src/mcp/server.ts, src/server/errors.ts, src/server/app.ts, tests/mcp-write-tools.test.ts, tests/app.test.ts
- Verify: `npm test -- tests/mcp-write-tools.test.ts tests/app.test.ts` on a fixture vault with a real bare remote (F1 merged); `save_note` commits and pushes a valid note and returns `path`, `commit`, `unchanged: false` and `redactions`, and the same call again returns `unchanged: true` with `commit: null` and no new commit; a fixture secret in the body and in a frontmatter string is stored as `[REDACTED:<rule>]` and listed in `redactions`; invalid frontmatter, wrong folder, duplicate source, existing path, unsafe path, invalid vault config, a push that always fails (`push_pending` with the local commit id) and a throwing scrubber (`scrub_failed`) each give `ok: false` with the same code and detail fields as `POST /notes`, and a sentinel request value appears in neither the result nor the logs; `save_recipe` writes `<recipe folder>/<slug of title>.md` with the configured recipe type, area, today's date (injected clock), `source` `mcp` when absent and `## Problem` and `## Solution` sections, and follows a config with a non-default recipe folder and mapped property names; an existing recipe path, an invalid area and a title whose slug is empty or reserved each give an error and write nothing; no tool name matches delete, move or archive; the ingest routes use the shared mapping in src/server/errors.ts (including the PATCH codes `note_not_found` and `immutable_body`) with unchanged responses
- Issue: #56
- Status: todo

## T14: update_properties tool
- Purpose: a client can change a note's properties through the F1 update path, with the same outcomes and errors as `PATCH /notes`, and never touch the body
- Covers: R9.3, R9.4
- Size: S
- Depends on: T13
- Files: src/mcp/tools/write.ts, src/mcp/server.ts, tests/mcp-write-tools.test.ts
- Verify: `npm test -- tests/mcp-write-tools.test.ts` on a fixture vault with a bare remote; `update_properties` with `{ path, set }` merges, commits and pushes and returns `path`, `commit` and `unchanged` as `PATCH /notes` does, with the body byte-identical; a missing path gives `note_not_found`; a `set` equal to the current values gives `unchanged: true`, `commit: null` and no commit; a bad date gives `invalid_frontmatter` and a type change that puts the path outside its folder gives `wrong_folder`, with file and HEAD unchanged; a fixture secret in a `set` value is stored redacted and `redactions` is returned; a push that always fails gives `push_pending` with the local commit id; an invalid vault config gives `config_invalid`; `set` alone on an `immutable_body` note succeeds; codes and detail fields equal those of `PATCH /notes` and no request value appears in the result or the logs; an input with `append` or `body` is rejected and writes nothing; the SDK v2 client lists `update_properties` and no tool name matches delete, move or archive
- Issue: #57
- Status: todo

## T15: OAuth flow end to end from the built entry point
- Purpose: the whole connector journey works from a real process, survives a restart, and a bad auth store stops startup
- Covers: R4.4, R5.5, R5.6, R6.1
- Size: M
- Depends on: T13
- Files: tests/mcp-flow.integration.test.ts, tests/helpers/oauth-client.ts
- Verify: `npm test -- tests/mcp-flow.integration.test.ts`; the test builds and spawns `dist/index.js` with a temp `AUTH_STORE_DIR`, a fixture vault and a random passphrase hash, then in order: `/mcp` without a token gives 401 with `resource_metadata` and that document names `<PUBLIC_BASE_URL>/mcp`; the SDK v2 client registers, the authorize page names the client, a wrong passphrase gets no code and the right one redirects with `code` and `state`; the code exchange returns tokens and a second exchange gives `invalid_grant`; `tools/call search` finds a seeded note and `save_note` returns a `commit` whose body `git show main:<path>` shows on the fixture remote; a refresh returns new tokens and the old refresh token is refused; after a restart on the same `AUTH_STORE_DIR` the refreshed access token still lists the tools; `auth.json` contains none of the issued codes, tokens or the client secret; revoke returns 200 and the token then gets 401; a spawn with an invalid `auth.json` exits 1 naming `auth.json` without printing its content; the research test-only mint route is not ported
- Issue: #58
- Status: todo

## T16: Container settings for the public app
- Purpose: the image and compose file run the public app with a capped heap inside the memory limit and a persistent, node-writable auth store
- Covers: R5.5, R1.1
- Size: S
- Depends on: T2, T4
- Files: Dockerfile, compose.yaml, tests/compose.test.ts, README.md
- Verify: `npm test -- tests/compose.test.ts`; the Dockerfile final stage has `ENV NODE_OPTIONS=--max-old-space-size=192` and creates `/data/auth` owned by `node` before `USER node`; compose mounts a named volume (declared under top-level `volumes`) at `/data/auth` in service `brain` and sets `AUTH_STORE_DIR` to `/data/auth`; `mem_limit` stays 512m; `brain` has no `ports` key and keeps `n8n` as its only network (the proxy reaches `MCP_PORT` over it); the existing healthcheck tests still pass; the `docker-build` CI check is green
- Issue: #59
- Status: done

## T17: MCP connection guide
- Purpose: an owner can follow one guide to set the passphrase hash, point a public URL at the service and add the endpoint in each client
- Covers: R11.1, R11.2
- Size: S
- Depends on: T15, T16
- Files: docs/GUIDE-mcp.md, README.md, tests/guide-mcp.test.ts
- Verify: `npm test -- tests/guide-mcp.test.ts`; the guide names `node dist/cli.js hash-passphrase`, `PUBLIC_BASE_URL`, `OWNER_PASSPHRASE_HASH`, `AUTH_STORE_DIR`, `MCP_PORT`, the connector URL `<PUBLIC_BASE_URL>/mcp`, the claude.ai custom connector steps, `claude mcp add --transport http` and the Codex or ChatGPT steps; README.md links to the guide; every env var in the guide appears in `.env.example`; neither file contains the em dash character
- Issue: #60
- Status: todo

## T18: Connect the real clients
- Purpose: the owner confirms claude.ai and a CLI client can connect, sign in and use the tools
- Covers: R11.1, R11.2
- Size: S
- Depends on: T17
- Files: docs/GUIDE-mcp.md
- Verify: `[manual]` (needs a public HTTPS URL and the owner's accounts; raised as an `rb:needs-local` issue with the exact steps): following docs/GUIDE-mcp.md, the owner adds the endpoint in claude.ai as a custom connector, signs in, and `search` and `save_note` work; the same with Claude Code and with Codex or ChatGPT for `search`; any guide step that failed is corrected in the guide
- Issue: #61
- Status: todo
