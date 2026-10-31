# Lessons

Project gotchas, written as instructions to a future agent. One entry per real incident,
1 to 3 lines, dated, newest last. Only the orchestrator (main session) appends here.
Planner and implementer prompts include the entries relevant to their task.

Format:
- YYYY-MM-DD: <instruction>. Why: <what went wrong once>.

<!-- Entries below this line -->
- 2026-10-31: never pass untrusted text to gray-matter's `matter.stringify(body, ...)` or a default `matter()` parse; go through `src/vault/frontmatter.ts`. Why: stringify parses its first argument and an empty `{}` lets a `---js` body become an executable header.
- 2026-10-31: in Hono tests, a string `body` gets `content-type: text/plain` automatically; to test a missing header send a `Uint8Array` body and delete the header. Why: a "no content-type" test silently repeated the text/plain case.
- 2026-10-31: after `biome migrate`, check that `recommended: true` did not become `preset: none`. Why: Biome 2.6.4 migrate disabled every lint rule.
