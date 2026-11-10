# 0023. MCP clients may append to the body of an existing note

Status: accepted
Date: 2026-11-10
Related: docs/adr/0011-note-write-operations.md, docs/specs/02-mcp-server/requirements.md (R9)
Approved by: owner, in conversation (2026-11-10)

## Context
Spec 02 let MCP clients create notes and set properties, but never touch the body of an existing
note, so a model reading untrusted text could not damage notes. In daily use this blocks the
owner's main flows: an ingest from a claude.ai project cannot add new facts to the project or
person note it finds, and `analizar-reunion` cannot add decisions to the project note. Each time
the client reports the update as manual work. The ingest API already appends safely
(`PATCH /notes` with `append`, ADR 0011): earlier bytes are kept, the text is scrubbed, remote
embeds are neutralized, and notes of an `immutable_body` type are refused.

## Decision
Add the MCP tool `append_to_note` (`path`, `text` up to 100,000 characters) that calls the same
`VaultWriter.patch` path with `append` only. `update_properties` keeps refusing `append`. There is
still no tool that rewrites, deletes, moves or archives a note.

## Alternatives considered
| Option | Why rejected |
|---|---|
| Keep body writes closed | The owner does every update by hand, which defeats the ingest |
| A tool that replaces a section or the whole body | A model could erase what the owner wrote |
| Allow `append` in `update_properties` | Mixes two operations in one tool and changes a tool clients already use |

## Consequences
- Positive: ingests and meeting analyses update project and person notes in place.
- Negative: a client can add wrong or excessive text at the end of a note. Nothing is removed,
  every append is one commit, and the owner sees it in Obsidian.
- Revisit when: appended text is often wrong, or the owner wants to review appends before they land.
