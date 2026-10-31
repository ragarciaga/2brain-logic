# Progress

Updated: 2026-10-31

## Current objective
Merge the kickoff PR, then build the walking skeleton issue.

## Current state
- Works: approved brief, ADRs 0001 to 0009, AGENTS.md contract, vendored harness.
- Broken: nothing yet; Verification commands do not exist until the skeleton is built.
- Pending: the owner merges the kickoff PR (tier C).

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

## Next steps
1. Merge the kickoff PR.
2. `/rb-build #<skeleton issue>` (or the nightly `/rb-cycle` picks it up).
3. `/rb-spec F1 vault core`.

## Timing
<!-- rb:timing:start -->
<!-- rb:timing:end -->
