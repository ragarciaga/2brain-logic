# 0001. Stack: TypeScript on Node.js 24

Status: accepted
Date: 2026-10-31
Related: docs/brief.md
Approved by: kickoff synthesis (2026-10-31)

## Context
One codebase holds the ingest service, the MCP server, the Claude Code plugin hooks and the installer. It must run in a small container next to n8n (under 512 MB) and be maintained by agents that benefit from type errors as fast feedback. The official MCP SDK is most mature in TypeScript.

## Decision
We will use TypeScript 7.0.2 (strict) on Node.js 24.22.2 LTS, Hono 4.13.14 for HTTP, @modelcontextprotocol/sdk 1.32.2, Zod 4.6.7 for every schema, gray-matter 4.0.3 for frontmatter, the git and ripgrep binaries from the image (no git library), Vitest 5.0.5 and Biome 2.6.4. Exact versions are pinned in package.json.

## Alternatives considered
| Option | Why rejected |
|---|---|
| Python (FastAPI, MCP Python SDK) | Two languages once the plugin and installer arrive (both Node-friendly); weaker static feedback for agents |
| Node with a git library (simple-git, isomorphic-git) | Extra dependency over a CLI the image already has; isomorphic-git is slower on large repos |
| Express or Fastify | Hono is smaller and its Web-standard handlers fit the MCP SDK's streamable HTTP transport |

## Consequences
- Positive: One language and shared Zod types from ingest to MCP; small image.
- Negative: TypeScript 7 is recent; a toolchain bug means pinning back to 6.x.
- Revisit when: The MCP SDK or TypeScript 7 blocks a feature for more than a day, or memory exceeds the 512 MB limit.
