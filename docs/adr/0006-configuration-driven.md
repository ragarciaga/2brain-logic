# 0006. Everything owner-specific comes from configuration

Status: accepted
Date: 2026-10-31
Related: docs/brief.md
Approved by: kickoff synthesis (2026-10-31)

## Context
The repository is public and meant to be installed by others. The reference install has Spanish folder names, specific areas, accounts and a domain.

## Decision
We will keep zero owner data in code, tests and docs. Areas, folder names, note types, languages, sources, the delete-after-days option and domains come from `.2brain/config.yaml` in the vault, validated with Zod at startup; secrets come from environment variables. Fixtures use fictional people and example.com.

## Alternatives considered
| Option | Why rejected |
|---|---|
| Fork per user | Every fix has to be ported; nobody gets updates |

## Consequences
- Positive: Any vault layout works; the author's install is just one config.
- Negative: Every feature needs a config schema and a default.
- Revisit when: A setting proves impossible to express without code.
