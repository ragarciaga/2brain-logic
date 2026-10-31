# 0011. Note writes: idempotent create, patch, archive

Status: accepted
Date: 2026-10-31
Related: docs/specs/01-vault-core/design.md
Approved by: the user, with design.md on 2026-10-31 (standing instruction in the build session)

## Context
Machine callers retry after network errors (issue #5), people and topics must be updated instead of duplicated (brief, AGENTS rule 4), and nothing may be deleted (ADR 0008). The skeleton only had create, which returned 409 for any existing path.

## Decision
We will offer three operations. Create returns 200 `unchanged` for byte-identical content at the path, 409 `note_exists` for different content, and 409 `duplicate_source` when the configured `source_id` already belongs to another note. Patch merges properties and appends text after one blank line, never rewriting earlier bytes; types configured with `immutable_body` (meetings) accept property changes only. Archive moves a note to `<archive folder>/<original path>`. No operation deletes a file.

## Alternatives considered
| Option | Why rejected |
|---|---|
| Upsert that overwrites | Loses content; breaks the rule that a transcript body never changes |
| Content-hash dedupe across paths | Rejects legitimate notes with equal text; source ids are the reliable key |

## Consequences
- Positive: Retries are safe, updates are explicit, the vault only grows.
- Negative: Callers must choose create or patch; a same-path different-content create is still a 409.
- Revisit when: Callers need full-body rewrites, or a source without stable ids.
