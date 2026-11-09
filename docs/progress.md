# Progress

Updated: 2026-11-09

## Current objective
F6 capture from Telegram and email (docs/specs/06-capture/): requirements and design approved on 2026-11-02 (23 criteria, ADRs 0021 to 0023, Anthropic Haiku 5.5 and Groq speech to text under USD 1 a month each). Next: `/rb-tasks docs/specs/06-capture/` (6 tasks planned in the design), then the spec PR and the build.

F5 meetings: every buildable task is merged (T1 to T18, plus the #233 hardening tasks 1 to 3); T19 (#214) and T20 (#215) are owner manual checks. The two meeting templates were imported into the owner's n8n as inactive `[2brain test]` drafts and passed pinned test runs (#214 has the results).

## Current state
- Works: walking skeleton (PR #10) plus F1 tasks merged: strict vault config and template (T1), INGEST_TOKEN required (T2), bearer token on every route except `GET /health` (T3), Windows-safe paths and literal pathspecs (T4), frontmatter validator (T6), config re-read after each pull with 503 `config_invalid` (T7), frontmatter validated on create with 400 (T8), `init-vault` (T16), template in the image and compose healthcheck (T17).
- Broken: nothing.
- Done: T5 scrubber (#69) and T9 scrub on create (#72); paths with a secret are refused. Idempotent create and source id dedupe done (T10, #74). Rebase conflicts keep both versions (T11, #77). Push retry and pending-commit delivery done (T12, #79). IBAN length table unverified against a named SWIFT release (#41, rb:needs-local).

## Key decisions
- 2026-11-01: the two versions of a meeting are two linked notes, see docs/adr/0018-meeting-versions-as-linked-notes.md
- 2026-11-01: meeting ingest contract (service maps the source API shapes), see docs/adr/0019-meeting-ingest-contract.md
- 2026-11-01: optional `meetings` section in the vault config, see docs/adr/0020-meetings-config-section.md
- 2026-11-01: Fireflies stays on the owner's current plan (USD 0); n8n polls when webhooks are not available
- 2026-10-31: TypeScript on Node.js 24 with Hono and the MCP SDK, see docs/adr/0001-stack.md
- 2026-10-31: workflow, not agent, see docs/adr/0002-workflow-vs-agent.md
- 2026-10-31: thin n8n, logic in the service, see docs/adr/0003-thin-n8n.md
- 2026-10-31: meetings without LLM calls, see docs/adr/0004-meetings-without-llm.md
- 2026-10-31: vault in its own Git repository, see docs/adr/0005-vault-in-git.md
- 2026-10-31: configuration-driven, see docs/adr/0006-configuration-driven.md
- 2026-10-31: MCP behind OAuth 2.1, see docs/adr/0007-mcp-auth.md
- 2026-10-31: secret scrub and no deletions, see docs/adr/0008-vault-safety.md
- 2026-10-31: SessionEnd hook in the plugin, see docs/adr/0009-session-end-hook.md
- 2026-10-31: ingest bearer token, see docs/adr/0010-ingest-bearer-token.md
- 2026-10-31: idempotent create, patch and archive, see docs/adr/0011-note-write-operations.md
- 2026-10-31: vault config maps canonical names to the owner's, see docs/adr/0012-vault-config-mapping.md
- 2026-10-31: MCP SDK v2 server package, see docs/adr/0013-mcp-sdk-v2.md
- 2026-10-31: built-in single-owner OAuth 2.1 server, see docs/adr/0014-built-in-authorization-server.md (benchmark: docs/research/mcp-oauth/REPORT.md)
- 2026-10-31: public MCP app separate from ingest, see docs/adr/0015-public-mcp-app.md
- 2026-10-31: session capture with headless claude on the owner's plan, see docs/adr/0016-session-capture-with-headless-claude.md
- 2026-11-01: installer runs in the service container, see docs/adr/0017-installer-runs-in-the-container.md
- 2026-10-31: skeleton bodies stored verbatim, 409 on an existing path, HOST defaults to 127.0.0.1, see PR #10

## Next steps
1. Agent: run `/rb-tasks docs/specs/06-capture/` on branch `rb/spec-06-capture` (spec already approved; do not ask again), open the spec PR, then build F6 with the lighter review the owner approved: tasks sized to about 6 PRs, verifier on every PR, blind auditor and security only where `rb risk` asks, at most 3 tasks in parallel when files do not overlap.
2. Agent: prototype the two F6 n8n templates live in the owner's personal n8n through Composio (inactive drafts named `[2brain test]`), then freeze them as templates with tests.
3. Done 2026-11-09: the owner merged PR #249 (n8n templates are tier B now).
4. Owner, in progress 2026-11-09: deploying on the server that already runs n8n and Caddy (n8n-docker-caddy example, Docker network `n8n-docker-caddy_default`, Compose 2.32.4) with docs/INSTALL.md; DNS record for the brain subdomain created. Agent, first thing next session: ask the owner for the doctor output and the domain, then close F4 manual checks #168 and #169.
5. Agent: add `restart: unless-stopped` to the `brain` service in compose.yaml (tier C, sensitive path; owner standing approval covers it) and drop the "After a host restart" section from docs/INSTALL.md. Today `brain` does not start again after a host reboot.
6. Owner: in the personal n8n, create the credentials `2brain ingest`, `Fireflies API`, `Telegram bot` (new bot from BotFather), `Speech to text` (Groq key) and `Gmail` (work account, OAuth), and send the Telegram chat id; then the agent runs T19 and the F6 live checks with real data.
7. Owner, optional: protect `main` with `rb protect` or a GitHub branch rule.
8. Later: #233 items 1 and 7 (spec changes) and 8, 9, 11, 12 (after the manual checks); the scrub boundary note on #233; F7 routines.

## Timing
<!-- rb:timing:start -->
| Task | plan | implement | check | verify | audit | fix | security | pr | ci | merge | Total |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| i2 | 9.4 | 11.4 | 0.2 | 7.5 | 6.6 | 2.1 | 9.3 | 0.9 | 1.2 | 0.4 | 49.0 |
| T1 | 4.4 | 4.1 |  | 1.2 | 2.3 | 0.8 | 2.0 |  |  |  | 14.8 |
| T2 | 4.4 | 1.4 |  | 3.3 | 1.8 | 0.7 | 2.0 |  |  |  | 13.6 |
| T6 | 2.8 | 2.0 |  | 2.0 | 2.4 |  | 2.1 |  |  |  | 11.3 |
| T16 | 3.3 | 2.4 |  | 3.0 | 1.9 | 1.2 |  |  |  |  | 11.8 |
| T3 | 3.7 | 4.7 |  | 2.4 | 3.0 |  | 3.5 |  |  |  | 17.3 |
| T4 | 3.2 | 3.7 |  | 2.8 | 1.7 |  | 0.8 |  |  |  | 12.2 |
| T7 | 3.7 | 3.2 |  | 3.7 | 2.4 |  |  |  |  |  | 13.0 |
| T17 | 2.7 | 2.1 |  | 2.1 | 12.8 |  | 1.3 |  |  |  | 21.0 |
| T5 | 10.1 | 32.6 |  |  |  |  | 14.9 |  |  |  | 57.6 |
| T8 |  |  |  |  |  |  |  |  |  |  | 0.0 |

Minutes per phase.
Open (started, not ended): T5/verify, T8/plan.
<!-- rb:timing:end -->
- 2026-11-01: retro on F4 and F5: 5 lessons, 0 config changes, 0 autonomy changes, 5 harness issues (ragarciaga/rockbuilt#45 to #49) plus evidence comments on ragarciaga/rockbuilt#42 and #43.
