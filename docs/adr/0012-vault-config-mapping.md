# 0012. Vault configuration maps canonical names to the owner's

Status: accepted
Date: 2026-10-31
Related: docs/specs/01-vault-core/design.md
Approved by: the user, with design.md on 2026-10-31 (standing instruction in the build session)

## Context
The product is installed by others with their own vault layout (ADR 0006); the reference vault uses Spanish property names and values (`tipo: reunion`, `fecha`). Validation must use the owner's names without code changes.

## Decision
We will validate notes with `.2brain/config.yaml`, a strict versioned schema that maps canonical properties (`type`, `area`, `date`, `source`, `source_id`) and canonical note types (with owner value, folder pattern and body rule) to the owner's names. The service re-reads it after every pull. Defaults are code (src/config/defaults.ts) mirrored by vault-template/.2brain/config.yaml, and a test keeps both identical.

## Alternatives considered
| Option | Why rejected |
|---|---|
| Fixed English names | Forces every owner to rename their vault |
| Config only at startup | A config change pushed from the PC would need a container restart |

## Consequences
- Positive: Any vault layout validates; config changes ship as vault commits.
- Negative: A strict schema rejects typos loudly (503 until fixed).
- Revisit when: Owners need per-folder rules the schema cannot express.
