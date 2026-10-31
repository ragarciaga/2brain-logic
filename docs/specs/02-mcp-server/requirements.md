# Requirements: MCP server with OAuth

Status: approved  |  Date: 2026-10-31  |  Spec: docs/specs/02-mcp-server/
Baseline: unknown
Approved by: the owner's standing instruction in the build session (2026-10-31): "fusiona el tier c, solo detente si involucra costos, de resto sigue" and "Fusiona y continúa, quiero la versión terminada". No cost items in this feature.
Brief: docs/brief.md  |  Research: docs/research/mcp-oauth/REPORT.md  |  ADRs: docs/adr/0007-mcp-auth.md, docs/adr/0013-mcp-sdk-v2.md, docs/adr/0014-built-in-authorization-server.md, docs/adr/0015-public-mcp-app.md

## Context
The vault core (F1) accepts writes only from the internal network. The owner also needs any AI client (claude.ai, ChatGPT, Claude Code, Codex) to search, read and write the vault from anywhere, which means a public endpoint. ADR 0007 forbids a public endpoint without OAuth 2.1. This feature adds a second, public HTTP app that serves the MCP endpoint (Streamable HTTP) behind a built-in single-owner OAuth 2.1 authorization server, and exposes six tools that reuse the F1 write path. It is core journey 1 of the brief.

## Users
- The vault owner, through an AI client: connects the client once with a passphrase, then searches, reads and saves notes.
- AI clients (claude.ai and ChatGPT connectors, Claude Code, Codex): discover OAuth from a 401, register, get and refresh tokens.
- A third party installing the product: sets a public URL and a passphrase hash, nothing else.

## Out of scope
- A second user per install, scopes (read versus write), Client ID Metadata Documents, OpenID discovery and a second factor: docs/v2.md.
- Semantic search: docs/v2.md (text search with ripgrep only).
- TLS and the reverse proxy route: the installer (F4) documents them; this service speaks plain HTTP behind the proxy.
- Archiving through MCP: notes are archived by the owner in Obsidian or by later features; no MCP tool moves or deletes files.

## Existing behavior to preserve
- The ingest API (POST and PATCH /notes, POST /notes/archive) stays on its own app, requires `INGEST_TOKEN`, and is not reachable from the public app: verified by tests/app.test.ts and a new test that the public app answers 404 for every ingest route `[integration]`
- `GET /health` on the ingest app without a token: verified by tests/auth.test.ts `[unit]`
- Every vault write goes through `src/vault/` (validation, scrub, dedupe): verified by the F1 integration tests `[integration]`

## R1: Public app, separate from ingest
As the owner, I want the public endpoint to expose only MCP and OAuth, so that the ingest API is never reachable from the internet.
- R1.1 When `PUBLIC_BASE_URL` is set, the system shall start a second HTTP app on `MCP_PORT` (default 3001) that serves only `/mcp`, the OAuth routes and `/.well-known/*`, and answer 404 for any other path. `[integration]`
- R1.2 When `PUBLIC_BASE_URL` is not set, the system shall not start the public app and shall log one line saying MCP is disabled. `[integration]`
- R1.3 If `PUBLIC_BASE_URL` is set but is not an `https` URL (except `http://localhost` or `http://127.0.0.1` for local use), or `OWNER_PASSPHRASE_HASH` is missing or malformed, then the system shall exit with code 1 and a message naming the variable, without printing its value. `[integration]`
- R1.4 The system shall derive the issuer, the resource URL (`<PUBLIC_BASE_URL>/mcp`) and every URL it advertises from `PUBLIC_BASE_URL`, never from the request `Host` or forwarded headers. `[unit]`

## R2: Discovery
As an AI client, I want to discover how to authenticate from a 401, so that the owner only pastes the URL.
- R2.1 When `/mcp` receives a request without a valid access token, the system shall respond 401 with `WWW-Authenticate: Bearer resource_metadata="<PUBLIC_BASE_URL>/.well-known/oauth-protected-resource/mcp"` (and `error="invalid_token"` when a token was sent). `[unit]`
- R2.2 The system shall serve an RFC 9728 protected resource metadata document at both `/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-protected-resource`, naming the resource and the authorization server. `[unit]`
- R2.3 The system shall serve an RFC 8414 authorization server metadata document at `/.well-known/oauth-authorization-server` listing the authorize, token, registration and revocation endpoints, `code` as the only response type, `S256` as the only PKCE method, and the client auth methods `none`, `client_secret_post` and `client_secret_basic`. `[unit]`

## R3: Dynamic client registration
As an AI client, I want to register myself, so that the owner does not create clients by hand.
- R3.1 When `POST /register` receives RFC 7591 metadata whose redirect URIs are all allowed, the system shall store the client and respond 201 with a `client_id` (and a `client_secret` unless the method is `none`). `[unit]`
- R3.2 A redirect URI shall be allowed only when it is `https` on a host in `ALLOWED_REDIRECT_HOSTS` (default `claude.ai,claude.com,chatgpt.com`), or `http` on a loopback host (`127.0.0.1`, `[::1]`, `localhost`) with any port. `[unit]`
- R3.3 If any redirect URI is not allowed, then the system shall respond 400 `invalid_redirect_uri` and store nothing. `[unit]`
- R3.4 If 50 clients are already registered, then the system shall respond 400 `invalid_client_metadata` naming the limit, and store nothing. `[unit]`

## R4: Authorization with owner sign-in
As the owner, I want to approve each new client with my passphrase, so that nobody else can connect to my vault.
- R4.1 When `GET /authorize` receives a known client, a redirect URI registered for it (exact match, except the port of a loopback URI), `response_type=code`, a `code_challenge` with method `S256`, and either no `resource` or the resource URL, the system shall show a sign-in page naming the client and the redirect host. `[integration]`
- R4.2 If the client is unknown or the redirect URI is not registered for it, then the system shall respond 400 with an error page and shall not redirect. `[unit]`
- R4.3 If PKCE is missing, uses `plain`, or `resource` names another URL, then the system shall redirect to the client with an RFC 6749 error (`invalid_request` or `invalid_target`). `[unit]`
- R4.4 When the owner submits the passphrase that matches `OWNER_PASSPHRASE_HASH` (scrypt, compared in constant time), the system shall redirect to the client with a single-use code and the client's `state`. `[integration]`
- R4.5 If the passphrase is wrong, then the system shall show the page again with a generic error; after 5 wrong attempts from one client IP within 15 minutes it shall refuse sign-in from that IP for 15 minutes with 429. `[unit]`
- R4.6 The sign-in page shall be served with `Cache-Control: no-store`, `X-Frame-Options: DENY` and a form that posts only to the same origin. `[unit]`

## R5: Tokens
As an AI client, I want access and refresh tokens that survive a restart, so that the owner connects only once.
- R5.1 When `POST /token` receives a valid code with the matching PKCE verifier, client authentication and redirect URI, the system shall issue an opaque access token valid for 1 hour and a refresh token valid for 30 days, both bound to the resource URL. `[unit]`
- R5.2 If a code is expired (older than 60 seconds), already used, or the verifier does not match, then the system shall respond 400 `invalid_grant`; when a used code is presented again, the system shall also revoke the tokens issued from it. `[unit]`
- R5.3 When a refresh token is used, the system shall issue a new access and refresh token and invalidate the old refresh token; if an invalidated refresh token is used again, then the system shall revoke every token of that grant. `[unit]`
- R5.4 When `POST /revoke` receives an RFC 7009 form request for a token of the authenticated client, the system shall revoke it (and its grant for a refresh token) and respond 200, also for an unknown token. `[unit]`
- R5.5 The system shall store clients and grants in a JSON file under `AUTH_STORE_DIR` (default `/data/auth`), written atomically, with tokens and client secrets stored only as SHA-256 hashes, and shall keep working tokens across a restart. `[integration]`
- R5.6 If the auth store file is unreadable or invalid at startup, then the system shall exit with code 1 naming the file, without printing its content. `[integration]`

## R6: Protected MCP endpoint
As the owner, I want the MCP endpoint to accept only my tokens, so that the vault stays private.
- R6.1 When `/mcp` receives an access token that is unexpired, unrevoked and bound to the resource URL, the system shall serve the MCP request (Streamable HTTP, JSON responses). `[integration]`
- R6.2 If the token is expired, revoked, unknown or bound to another resource, then the system shall respond 401 as in R2.1. `[unit]`
- R6.3 The system shall reject requests to `/mcp` whose `Origin` header is present and not an allowed origin (`PUBLIC_BASE_URL` or an `https` origin on an allowed redirect host) with 403. `[unit]`

## R7: Rate limits
As the owner, I want abuse of the public endpoints to be throttled, so that a bot cannot fill the store or guess the passphrase.
- R7.1 The system shall limit `POST /register` to 10 per hour, `POST /token` to 60 per minute and sign-in submissions to 10 per minute per client IP, and respond 429 with `Retry-After` beyond that. `[unit]`
- R7.2 The system shall take the client IP from the socket, or, when `TRUST_PROXY_HOPS` is 1 or more, from the matching entry counted from the right of `X-Forwarded-For`; a client-supplied leftmost value shall never be used. `[unit]`

## R8: Read tools
As the owner, I want to search and read my vault from an AI client, so that I find decisions and figures without opening Obsidian.
- R8.1 When the `search` tool receives a query, the system shall pull the vault, run ripgrep over the Markdown files as a fixed string (case-insensitive), excluding `.git` and the archive folder, and return at most `limit` (default 20, max 50) results with path, title and a line snippet. `[integration]`
- R8.2 When the `read` tool receives a path, the system shall return the note's frontmatter and body; if the path is unsafe, outside the vault, or missing, then it shall return a tool error (`unsafe_path` or `note_not_found`). `[integration]`
- R8.3 When the `recent` tool is called, the system shall return the notes changed in the last `days` (default 7, max 90), newest first, at most `limit` (default 20, max 50), with path, title, type and last commit date. `[integration]`
- R8.4 The system shall answer `search` over 10,000 notes in under 2 seconds on the reference host. `[integration]`

## R9: Write tools
As the owner, I want to save notes and validated recipes from an AI client, so that work from a chat lands in the vault.
- R9.1 When `save_note` receives path, frontmatter and body, the system shall write it through the F1 create path (validation, scrub, dedupe, commit and push) and return the same outcome fields as `POST /notes` (`path`, `commit`, `unchanged`, `redactions`). `[integration]`
- R9.2 When `save_recipe` receives a title, area, the problem, the steps or code that worked and an optional source, the system shall build a note of the configured `recipe` type in its folder and save it as in R9.1. `[integration]`
- R9.3 When `update_properties` receives a path and properties, the system shall apply them through the F1 property update path and return its outcome. `[integration]`
- R9.4 If the F1 path rejects a write, then the tool shall return a tool error with the same error code and detail fields the HTTP API returns, never a stack or a request value. `[unit]`
- R9.5 The system shall expose no tool that deletes, moves or archives a file. `[unit]`

## R10: Owner setup
As a third party installing the product, I want to create my passphrase hash with one command, so that I never store the passphrase.
- R10.1 When `node dist/cli.js hash-passphrase` reads a passphrase of at least 12 characters from standard input, the system shall print an `OWNER_PASSPHRASE_HASH` value (scrypt with a random salt and its parameters) and nothing else. `[integration]`
- R10.2 If the passphrase is shorter than 12 characters, then the command shall exit with code 1 and print no hash. `[integration]`

## R11: Real clients
As the owner, I want the endpoint to work with the clients I use, so that journey 1 of the brief holds.
- R11.1 The owner shall be able to add the endpoint as a custom connector in claude.ai, sign in, and run `search` and `save_note`. `[manual]` (needs a public HTTPS URL and the owner's claude.ai account; done as an `rb:needs-local` step before the proxy route opens)
- R11.2 The owner shall be able to add the endpoint in Claude Code and in Codex or ChatGPT, sign in, and run `search`. `[manual]` (same reason)
