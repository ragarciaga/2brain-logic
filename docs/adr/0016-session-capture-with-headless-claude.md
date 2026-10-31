# 0016. Session capture with a detached headless `claude -p` on the owner's subscription

Status: accepted
Date: 2026-10-31
Related: docs/specs/03-claude-code-plugin/design.md, docs/adr/0009-session-end-hook.md, docs/adr/0007-mcp-auth.md, docs/adr/0015-public-mcp-app.md
Approved by: pending (the owner's decision on the capture mechanism is recorded below; the ADR is accepted with design.md)

## Context
ADR 0009 puts session capture in this repository's Claude Code plugin at SessionEnd. Three facts
shape how the capture runs:
- Claude Code gives SessionEnd hooks a 1.5 second budget, and timeouts set on plugin-provided
  hooks do not raise it (https://code.claude.com/docs/en/hooks). A summary cannot be produced and
  saved inside the hook.
- The ingest HTTP API listens only on the internal Docker network (ADR 0007, ADR 0015). The only
  write path from the owner's machine is the public MCP endpoint behind OAuth, which the owner has
  already signed in to from Claude Code.
- The Anthropic API budget is USD 20 per month for the whole install (brief). The owner already
  pays for a Claude subscription, and `claude -p` uses that login unless an API key or other
  credential is present (https://code.claude.com/docs/en/authentication). `--bare` cannot be used,
  because it never reads the subscription login (https://code.claude.com/docs/en/headless).

## Decision
We will capture each substantive session by having the plugin's SessionEnd hook start a detached
worker, which runs one headless `claude -p` session on the owner's subscription with no built-in
tools and only the brain MCP tools allowed (`vault_info`, `search`, `read`, `save_note`,
`save_recipe`, `update_properties`), with API credentials removed from its environment and a
`TWOBRAIN_CAPTURE=1` guard against recursion; that session writes the session note, validated
recipes and person properties to the vault over MCP with the owner's existing sign-in.

## Alternatives considered
| Option | Why rejected |
|---|---|
| Deterministic capture from docs/progress.md only, no model | Rejected by the owner: misses every session outside Rockbuilt projects, and cannot pick decisions or validated recipes out of the conversation |
| Anthropic API summary (worker or service), about USD 0.05 per session | Rejected by the owner: several sessions a day would take most of the USD 20 cap, and every machine would need an API key |
| Post the summary to the ingest HTTP API | Not reachable from the owner's machine (internal network only, ADR 0007, ADR 0015) |
| Prompt or agent hook type at SessionEnd | Bound by the 1.5 second budget that plugin hooks cannot raise |

## Consequences
- Positive: USD 0 API cost; no new credential on the owner's machine; the same MCP tools and
  write path as every other client, so validation, scrub and dedupe are shared; exit stays fast.
- Negative: uses plan quota (one short run per substantive session); depends on Claude Code's
  `-p` flags, hook contract and transcript format, which can change; summary quality has no
  automated eval (manual checks only); a capture fails until the owner signs in to the MCP server
  with a user-scoped server.
- Revisit when: Claude Code changes the SessionEnd or `-p` contract, plan limits make the
  headless runs a problem, or the owner accepts API cost for unattended summaries.
