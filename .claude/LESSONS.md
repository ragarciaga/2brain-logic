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
- 2026-10-31: do not run `rb gh pr-update-branch` before `rb merge-gate` says `behind`; then carry the verifier line with `rb review-delta --line`. Why: updating early made the T6 review lines stale.
- 2026-10-31: mutation probes and scratch runs write only under the scratchpad or an OS temp dir, never inside the worktree. Why: a stray `a/` directory from a probe landed in the T16 commit.
- 2026-10-31: tests of git pathspec or glob behavior need tracked or staged files; untracked files alone do not exercise them. Why: a T4 glob test passed without the fix.
- 2026-10-31: before a regex mutation probe, check the mutant cannot go quadratic on the 1 MiB fixtures; run it with a vitest timeout. Why: a mutated scrub pattern hung the T5 suite.
- 2026-10-31: never run the verifier (mutation probes in place) and the auditor or security reviewer on the same worktree at once; run the verifier first or give the others a `git archive` export. Why: the T8 auditor saw the verifier's mutants and its in-worktree test runs failed.
- 2026-10-31: when editing text with JavaScript `String.replace`, pass a replacer function (or escape `$`) if the replacement can contain `$`; `$\x60` and `$'` insert the text around the match. Why: F2 T1 duplicated half of .env.example and README.md through a `$\x60` in a comment.
- 2026-10-31: every agent prompt names its own scratchpad subdirectory (for example `scratchpad/<task>-<role>/`); never use shared names like `mut.mjs` or cwd-relative scratch paths. Why: the F1 T5 implementer ran another agent's `mut.mjs`, which rewrote `src/config/env.ts` in the wrong worktree (restored, no diff left).
- 2026-10-31: the CI gitleaks step scans every commit of a PR, so a secret-shaped fixture literal fixed in a later commit still fails; build fixture secrets from parts from the first commit, and when one slips in, open a fresh single-commit branch (force-push is not available). Why: PR #67 failed twice after the literal was already split; #68 with one commit passed.
- 2026-10-31: a rewrite of a matching grammar (labels, patterns) ships with a sweep test that compares the new matcher against the previous reviewed head over a generated product of shapes. Why: T5 Revision 5 passed every example test and still regressed 32,834 label shapes; only a sweep found it.
- 2026-10-31: Zod 4 `z.record` and strict objects silently drop a `__proto__` key from `JSON.parse` output; scan for it explicitly when a parsed file must reject it. Why: the F2 T4 store schema accepted a `__proto__` key until a scan was added.
- 2026-10-31: a Zod schema built from constants exported by a module in an import cycle (metadata.ts, app.ts, register.ts) must be built lazily inside a function. Why: an eager `z.enum(CLIENT_AUTH_METHODS)` in F2 T6 crashed the metadata tests at import.
- 2026-10-31: when a guard such as a size check short-circuits a byte comparison, the "different content" test needs same-size bytes. Why: in T10 a mutant replacing the comparison with a length check survived until the fixture was made the same length.
- 2026-10-31: to simulate state that appears after the pull in a write-path test, inject it through `pullRebase` and assert the log line that proves which step failed. Why: a T10 test that dirtied the tree before the request failed on the pull and never reached the commit it meant to test.
- 2026-10-31: never point the auditor or security reviewer at a worktree while the verifier runs mutation probes there, even for a short confirmation round; give them an export. Why: in the T10 confirmation round the auditor saw the verifier's mutant in src/git/index.ts and flagged an unknown writer.
- 2026-10-31: never run `git checkout --` on the bookkeeping files in the main checkout, and after a `git pull` read the bookkeeping branch by its ref, not FETCH_HEAD. Why: the orchestrator discarded unsaved bookkeeping and then restored main's copies from a stale FETCH_HEAD.
