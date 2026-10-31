# 2brain-logic

Docs language: en
Project type: automation, ai
Default branch: main
Autonomy: auto
Parallel: auto
Max parallel: 3
Max tasks per run: 6

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
- @modelcontextprotocol/sdk 1.32.2 (https://github.com/modelcontextprotocol/typescript-sdk)
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
Sensitive paths: src/auth/**, src/vault/scrub/**, src/sources/**/delete*.ts, Dockerfile, compose*.yaml, n8n/templates/**
Tier A paths: vault-template/**
Paid services: Anthropic API (monthly cap USD 20)

How the harness decides (computed by `rb risk` from the real diff; the highest tier wins):

- **Tier A** (tests, docs, styles, copy, plus `Tier A paths`): planned, built, verified and
  merged without the human.
- **Tier B** (normal production code from an approved spec or an `rb:task` / `rb:bug` issue):
  also verified by a blind auditor, then merged without the human when CI is green.
- **Tier C** (architecture or design decisions, anything that can cost money, dependencies,
  data and schema, auth, permissions, payments, CI and deploy, harness files, secrets, large
  deletions, `Sensitive paths`): the harness stops on that item, labels the issue
  `rb:needs-human`, posts the question with options, a recommendation and a cost estimate, and
  moves on to other work. Tier C pull requests are merged by the human.

How to answer an escalation: reply on the issue (an answer, or "approved") and remove the
`rb:needs-human` label, or add the `rb:approved` label. The next run continues from there.
Approval covers the plan as posted; a revised plan asks again. Items labelled `rb:needs-local`
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
