# 2brain-logic

Docs language: en
Project type: automation, ai
Default branch: main
Autonomy: auto
Parallel: auto
Max parallel: 3
Max tasks per run: 6
Kickback budget: 2
Profile: full
Feature review: off
Launch: not set
Branch protection: declined (2026-11-12, owner keeps main unprotected for now)

This file is the project contract. Every coding agent (Claude Code, Cursor, Codex) reads it, and
the Rockbuilt harness (`node tools/rockbuilt/rb.mjs`) parses its header lines and sections. Keep
the headings exactly as written.

## Goal
A self-feeding second brain that anyone can install: meetings, emails, ideas and AI work
sessions land in an Obsidian vault stored in Git, classified and linked, and any AI client can
search and write it over MCP.
Today the knowledge is scattered across Fireflies, inboxes, chats and terminals, and the owner
loses decisions, figures and code that worked, or spends time re-finding them.
Inputs: n8n webhooks and schedules (Fireflies, Gemini, Gmail, Telegram), MCP calls, the Claude
Code plugin. Processing: deterministic normalization, a few fixed LLM steps, secret scrubbing,
git commit. Output: Markdown notes with validated frontmatter in the owner's vault repository.

Product context: docs/brief.md (greenfield).

## Stack
- Node.js 24.22.2 LTS (https://nodejs.org/docs/latest-v24.x/api/)
- TypeScript 7.0.2, strict (https://www.typescriptlang.org/docs/)
- Hono 4.13.14 + @hono/node-server 2.1.5 (https://hono.dev/docs/)
- @modelcontextprotocol/server 2.4.0, @modelcontextprotocol/client 2.4.0 for tests (https://github.com/modelcontextprotocol/typescript-sdk), see docs/adr/0013-mcp-sdk-v2.md
- Zod 4.6.7 (https://zod.dev)
- @anthropic-ai/sdk 1.3.0 (https://docs.claude.com/en/api/client-sdks)
- gray-matter 4.0.3 (https://github.com/jonschlinkert/gray-matter)
- ripgrep and git CLI from the container image (https://github.com/BurntSushi/ripgrep)
- Vitest 5.0.5 (https://vitest.dev), Biome 2.6.4 (https://biomejs.dev)
- Docker Compose (https://docs.docker.com/compose/); n8n templates target n8n 2.39.8 (https://docs.n8n.io)

Pin exact versions in package.json (`npm install -E`). Stack decisions and their reasons:
docs/adr/.

## Conventions
- No owner data in code, tests or docs: names, domains, emails, areas and folder names come from
  the vault's `.2brain/config.yaml`. Fixtures use fictional people and `example.com`.
- Every vault write goes through `src/vault/` (frontmatter validated with Zod, secret scrub,
  dedupe). Nothing is deleted from a vault; "remove" means move to the configured archive folder.
- A transcript body is never modified after it is stored; only its frontmatter may change.
- Git runs only through `src/git/`, with `execFile` and argument arrays (no shell strings):
  pull with rebase before a write, commit and push after it.
- LLM calls only through the interface in `src/llm/`. Tests and evals use the mock provider.
  The meeting flow makes zero LLM calls (docs/adr/0004-meetings-without-llm.md).
- The ingest HTTP API listens only on the internal Docker network. The MCP endpoint is public
  only behind OAuth (docs/adr/0007-mcp-auth.md).
- Secrets only from environment variables, listed in `.env.example`, never logged.
- n8n workflow templates live in `n8n/templates/*.json` with no credentials inside, only
  credential names the installer maps.
- The Claude Code plugin lives in `plugin/`; the default vault template in `vault-template/`.
- Never use the em dash character in any file.

## Verification
```bash
npm run typecheck
npm run lint
npm test
npm run build
```

## Evals
```bash
npm run evals
```

## Setup
```bash
npm ci
```

## Autonomy
Sensitive paths: src/auth/**, src/vault/scrub/**, src/sources/**/delete*.ts, Dockerfile, compose*.yaml
Tier A paths: vault-template/**
Paid services: Anthropic API (monthly cap USD 20)

How the harness decides (computed by `rb risk` from the real diff; the highest level wins):

- **Level 1** (docs, styles, copy, tests that only add, plus `Tier A paths`): merged on green CI,
  no agent review.
- **Level 2** (normal production code): the verifier reviews it; the blind auditor too when
  something the user sees changes, and on one PR in five by sampling. Merged when CI is green.
- **Level 3** (`Sensitive paths`, auth, permissions, payments, personal data, deletion, schema,
  CI and deploy, harness files, large diffs): verifier, blind auditor and security reviewer.
- **Profile** (header): `full` is the above. `minimal` merges levels 1 and 2 on green CI and gives
  level 3 the verifier and the security reviewer. `none` means the project runs without the harness.
- **Launch** (header, `YYYY-MM-DD` or `not set`): the day real users arrive. Before it, `/rb-attack`
  attacks the live system once within a scope you approve; critical findings carry
  `rb:launch-blocker` and every report lists them first.
- **Feature review** (header, `on` or `off`): with `on`, level 2 tasks of a spec merge into
  `rb/feature-<NN-slug>` with CI and the verifier, and the blind auditor and the security reviewer
  review the whole feature once, in its PR to the default branch. Level 3 tasks never go there.
- **The owner approves the plan** only for schema and migrations, architecture (ADR, a new spec,
  a design decision), the auth model, a cost outside `Paid services` or over its cap, and anything
  irreversible. Everything else takes a safe default and is reported. The harness sets the item
  aside (`rb:approval-pending`), keeps working, and sends one message per run with every decision.
  Once approved, the merge is automatic.

How to approve: write "aprobado" (or "approved") on the issue, after the plan. To hand approvals
over for a while, say so in a session ("delego todo hasta el viernes", "full auto del milestone
MVP"): it is recorded on the control issue with your words (`rb delegate`), for 14 days by
default, without cost or irreversible items unless you name them.
An approval covers the plan as posted; a revised plan asks again. `Kickback budget` (0 to 3) is how
many review rounds a task gets before it is marked blocked. Items labelled `rb:needs-local`
need your machine (for example a browser or local credentials) and include exact steps.

To stop all autonomous work, add the `rb:stop` label to any open issue (or to the
`Rockbuilt control` issue); remove it to resume. `Autonomy: supervised` in the header makes every
pull request wait for the human.

## Out of scope
Deferred scope with reasons: docs/v2.md.
- Analyzing meetings with the API: analysis runs in the owner's Claude subscription through the
  `analizar-reunion` skill.
- Storing tasks: tasks belong to the owner's task tool (Notion via n8n), not to the vault.
- Deploying from CI to anyone's server.
