# 0018. Two versions of one meeting are two linked notes

Status: accepted
Date: 2026-11-01
Related: docs/specs/05-meetings/design.md
Approved by: owner, with docs/specs/05-meetings/design.md (2026-11-01)

## Context
The owner records many meetings with both Fireflies and Gemini, so the same meeting arrives twice,
minutes or hours apart, in either order. A stored transcript body is never modified (AGENTS.md,
ADR 0011 `immutable_body`), and ADR 0004 says a meeting is stored "with the source suffix when
both sources exist". The `analizar-reunion` skill already analyzes the notes of one meeting from
different sources together (F3 R9.2). File names are visible to the owner and targets of the
owner's own links, so they are hard to change once notes exist.

## Decision
We will store each source's transcript as its own meeting note. The first version to arrive keeps
the plain name `YYYY-MM-DD · <title>.md`; a later version of the same meeting (other source, same
calendar event id or at least 50% time overlap) goes in the same folder as
`<first base name> (<source label>).md`. Both notes get a `versions` property with a wikilink to
the other, set in the same commit; neither body changes.

## Alternatives considered
| Option | Why rejected |
|---|---|
| One merged note with both transcripts | The second arrival would rewrite a stored body |
| Suffix every note with its source | Noisier names for the common single-source meeting; departs from ADR 0004 |
| Rename the first note when the second arrives | Moves a stored file, breaks the owner's links, needs a rename operation the vault core does not have |
| A third hub note per meeting | One more note per meeting with no content of its own; the `versions` property gives the same navigation |

## Consequences
- Positive: Bodies stay immutable; arrival order does not matter; the skill finds both versions by link.
- Negative: Which version gets the plain name depends on arrival order; the suffix appears on only one of the two.
- Revisit when: The owner wants one canonical note per meeting, or a third meeting source is added.
