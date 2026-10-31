# Brief (written 2026-10-31, before any spike ran)

Use case: one owner per install exposes a remote MCP endpoint (Streamable HTTP) protected by
OAuth 2.1 (RFC 8414 and/or RFC 9728 discovery from a 401, RFC 7591 dynamic client registration,
authorization code + PKCE S256, refresh tokens, revocation) that claude.ai, ChatGPT, Claude Code
and Codex can add; the owner proves identity at the authorize step with a passphrase.

Candidates: A @modelcontextprotocol/sdk 1.32.2 server auth + transport; B @hono/mcp (Hono
native); C hand-rolled authorization server in Hono around the MCP transport of A or B.

Criteria and weights (fixed now): security fit 30, works with claude.ai/ChatGPT style flow 25,
stack fit with Hono 20, memory and dependencies 15, maintenance 10. Each scored 1 to 5.

Test set (same for every candidate, scripted in shared/flow.mjs):
1. Unauthenticated POST /mcp returns 401 with WWW-Authenticate resource_metadata.
2. GET protected resource metadata (RFC 9728) and authorization server metadata (RFC 8414).
3. Dynamic client registration with a loopback redirect URI.
4. Authorize with PKCE S256 and resource; wrong passphrase rejected; right passphrase gives code.
5. Code exchange; second use of the same code rejected.
6. initialize + tools/call ping over Streamable HTTP.
7. 100 ping calls, then RSS.
8. Refresh (rotation: old refresh token rejected afterwards).
9. Revoke; revoked token rejected.
10. Expired token rejected; wrong-audience token rejected.
Hard cases: H1 authorize and token with no `resource` parameter; H2 client registered with
redirect https://evil.example.net/cb then authorize asks for a redirect on another host;
H3 plain PKCE method or missing code_challenge rejected.

Safety: everything on 127.0.0.1, fake passphrase generated per run, no accounts, no paid calls.
