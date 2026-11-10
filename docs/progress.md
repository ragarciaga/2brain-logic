# Progress

Updated: 2026-11-10

## Current objective
None open. F1 to F5 are merged and running on the reference install. The backlog is empty apart from the Rockbuilt control issue (#1). Next work comes from real use; deferred items with their revisit triggers are in docs/v2.md.

## Current state
- Works, in production on the reference install since 2026-11-09:
  - Service and installer (F1, F4): `setup` and `doctor` (11 of 11 pass), restart after a host reboot (#254), config folders and areas follow the note path rule (#258).
  - MCP (F2): nine tools behind the built-in OAuth server, used from claude.ai and Claude Code. `append_to_note` adds text to an existing note (#261, ADR 0023); write tools point clients to `vault_info` (#260).
  - Meetings (F5, reworked): on demand through `import_meetings` plus a daily sweep in one n8n workflow; Gemini from the "Notes by Gemini" doc via Composio; calendar lookup via Composio; area rules by title prefix; failure step names in the summary (#254, #256, #257, ADR 0021).
  - Vault safety: scrubber gaps closed (#127, #42), remote image embeds neutralized (#135, ADR 0022), recovery from a crash between a meeting write and its commit (#233), all in #259.
  - Docs: INSTALL from the first real deployment (#250), GUIDE-meetings rewritten, GUIDE-obsidian (#260).
- Broken: nothing known.
- Dropped by the owner (2026-11-09, docs/v2.md): Claude Code plugin capture beyond SessionEnd, Telegram, hourly meeting polling. Their manual checks (#109 to #114, #214, #215) were closed as not planned.

## Key decisions
- 2026-11-10: MCP clients may append to an existing note, see docs/adr/0023-mcp-append.md
- 2026-11-10: remote image embeds are neutralized on every vault write, see docs/adr/0022-remote-embeds.md
- 2026-11-09: meetings import on demand plus a daily sweep; Gemini from the notes doc through Composio, see docs/adr/0021-meetings-on-demand.md
- 2026-11-09: area rules may match an event title prefix (#256)
- 2026-11-09: plugin capture, Telegram and hourly polling deferred, see docs/v2.md
- 2026-11-01: the two versions of a meeting are two linked notes, see docs/adr/0018-meeting-versions-as-linked-notes.md
- 2026-11-01: meeting ingest contract (service maps the source API shapes), see docs/adr/0019-meeting-ingest-contract.md
- 2026-11-01: optional `meetings` section in the vault config, see docs/adr/0020-meetings-config-section.md
- 2026-11-01: Fireflies stays on the owner's current plan (USD 0); polling replaced by on-demand import in ADR 0021
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
1. Use it daily: "actualiza el cerebro" at the end of chats, "analiza mi reunión" after meetings, one ingest per claude.ai project with old chats.
2. Watch the Composio managed-app cap (20,000 calls a month on the free plan); the import uses a few hundred.
3. Open an `rb:task` or `rb:bug` issue for anything real use turns up.

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
- 2026-11-10: retro on the out-of-cycle work of 2026-11-09 and 2026-11-10 (PRs #250 to #262): 2 lessons, 1 config change (baseline recorded; branch protection left to the owner, `rb protect` was blocked in the cloud session), 0 autonomy changes, 5 harness issues (ragarciaga/rockbuilt#63 to #67) plus related links on #55, #56, #59 and evidence on #60.
