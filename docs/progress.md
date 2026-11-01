# Progress

Updated: 2026-11-01

## Current objective
F5 meetings without LLM (docs/specs/05-meetings/): Fireflies and Gemini transcripts from n8n stored deterministically, both versions of a meeting linked, zero LLM calls. Backlog: 20 tasks, issues #196 to #215 (T19, T20 manual). F1 to F4 are merged; F4 manual checks T23 (#168) and T24 (#169) and F3 manual checks (#109 to #114) wait for the owner.

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
1. Finish F1: T8, then T9, then T10 and T11, T12, T13, T14, T15 (each depends on the previous).
2. Owner: check #41 against the SWIFT registry on your machine.
3. F2: T1 to T11 can run in parallel with F1; F2 T13 and T14 start after F1 is merged. T18 (#61) needs the owner: a public HTTPS URL and the claude.ai account.

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
