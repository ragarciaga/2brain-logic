# Progress

Updated: 2026-10-31

## Current objective
Write the F1 spec (vault core) with `/rb-spec`.

## Current state
- Works: walking skeleton merged (PR #10, issue #2): `GET /health`, `POST /notes` writing and pushing to the vault repo, config and env loaders, mock LLM, 3 evals, Docker image and CI. Baseline green at 468942c (typecheck, lint, 99 tests, build).
- Broken: nothing.
- Pending: follow-ups #4 to #9 (ingest auth, failed push, rebase conflicts, healthcheck, known_hosts, ingest hardening). `/notes` has no auth or secret scrub until F1: do not connect real n8n flows.

## Key decisions
- 2026-10-31: TypeScript on Node.js 24 with Hono and the MCP SDK, see docs/adr/0001-stack.md
- 2026-10-31: workflow, not agent, see docs/adr/0002-workflow-vs-agent.md
- 2026-10-31: thin n8n, logic in the service, see docs/adr/0003-thin-n8n.md
- 2026-10-31: meetings without LLM calls, see docs/adr/0004-meetings-without-llm.md
- 2026-10-31: vault in its own Git repository, see docs/adr/0005-vault-in-git.md
- 2026-10-31: configuration-driven, see docs/adr/0006-configuration-driven.md
- 2026-10-31: MCP behind OAuth 2.1, see docs/adr/0007-mcp-auth.md
- 2026-10-31: secret scrub and no deletions, see docs/adr/0008-vault-safety.md
- 2026-10-31: SessionEnd hook in the plugin, see docs/adr/0009-session-end-hook.md
- 2026-10-31: skeleton bodies stored verbatim, 409 on an existing path, HOST defaults to 127.0.0.1, see PR #10

## Next steps
1. `/rb-spec F1 vault core` (config schema, vault template, validated frontmatter, secret scrub, dedupe, archive, conflicts; decide #4).
2. Optional: create the nightly routine (`Run /rb-cycle. [rockbuilt:unattended]`), now that `npm ci` works.

## Timing
<!-- rb:timing:start -->
| Task | plan | implement | check | verify | audit | fix | security | pr | ci | merge | Total |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| i2 | 9.4 | 11.4 | 0.2 | 7.5 | 6.6 | 2.1 | 9.3 | 0.9 | 1.2 | 0.4 | 49.0 |

Minutes per phase.
<!-- rb:timing:end -->
