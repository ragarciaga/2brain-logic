# Tasks: Vault core
Spec: docs/specs/01-vault-core/  |  Status: approved  |  Converged: 2026-10-31, 2 rounds, not converged (round 2 rewrites of T13, T15 and the T16 split applied verbatim from their reviewers, no third round)

<!--
Field names and statuses stay in canonical English (parsed strictly by `rb tasks`; unknown keys
or statuses are errors). Statuses: todo, in-progress, in-review, done, blocked.
The walking skeleton already exists (issue #2, merged in PR #10); T1 is the first feature task.
Order: config and auth first, then the create pipeline, then sync robustness, then patch and
archive (which reuse the sync), then packaging.
-->

## T1: Strict vault config with canonical mapping, defaults and template
- Purpose: the owner's own property names, areas and note types drive every later check, with a working default for a new vault
- Covers: R2.1, R2.2, R9.1, R9.3
- Size: M
- Depends on: none
- Files: src/config/vault-config.ts, src/config/defaults.ts, vault-template/**, vault-template/.2brain/config.yaml, tests/vault-config.test.ts, tests/template.test.ts
- Verify: `npm test -- tests/vault-config.test.ts tests/template.test.ts`; cases: absent config gives the defaults; mapped owner property names are exposed by the loaded config; an unknown key and a wrong-typed value each throw `ConfigInvalidError` with the file and key path; the template config parses to exactly the defaults object; every configured type folder (with `{area}` expanded per area) exists in the template; the template has no names, domains or emails other than example.com
- Issue: #12
- Status: done

### Decision log
- 2026-10-31: README.md placeholders, extensible type keys, optional version, sections replace defaults; Tier B. Outcome: reviews pass after 1 kickback, PR #30.

## T2: Require INGEST_TOKEN at startup
- Purpose: the service refuses to start without a strong ingest token and never echoes its value
- Covers: R1.3
- Size: S
- Depends on: none
- Files: src/config/env.ts, .env.example, README.md, tests/env.test.ts
- Verify: `npm test -- tests/env.test.ts`; missing INGEST_TOKEN, an empty value and a 31-character value each throw an error that names INGEST_TOKEN and does not contain the supplied value; a 32-character value passes; the full-object expectation includes the token
- Issue: #13
- Status: done

### Decision log

## T3: Bearer token check on every route except GET /health
- Purpose: only callers holding the token can write to the vault, and the token never leaks
- Covers: R1.1, R1.2, R1.4
- Size: M
- Depends on: T2
- Files: src/auth/ingest-token.ts, src/server/app.ts, src/index.ts, tests/auth.test.ts, tests/app.test.ts, tests/notes.integration.test.ts, tests/start.test.ts
- Verify: `npm test -- tests/auth.test.ts tests/app.test.ts tests/notes.integration.test.ts tests/start.test.ts`; POST /notes and an unknown route with no header, a non-Bearer scheme, a wrong token and a different-length token each return 401 `unauthorized` with zero writer and git calls; GET /health without a token returns 200 `{ ok: true }`; with a wrong header value and a failing writer, neither logs nor response bodies contain the header value or the real token; the existing 413, 415, 400 and 409 cases still pass with the token
- Issue: #14
- Status: done

### Decision log

## T4: Reject Windows-unsafe and pathspec-magic paths
- Purpose: a note name can never break a Windows checkout or make git stage other files
- Covers: R8.5
- Size: S
- Depends on: T3
- Files: src/vault/note-schema.ts, src/git/index.ts, tests/note-schema.test.ts, tests/app.test.ts, tests/git.test.ts
- Verify: `npm test -- tests/note-schema.test.ts tests/app.test.ts tests/git.test.ts`; `NoteInput` rejects a leading `:`, each of `<>:"|?*`, a segment ending in a dot, one ending in a space, and CON, PRN, AUX, NUL, COM1, LPT1 in any case and with an extension (`con.md`), while a normal path passes; app.test.ts returns 400 with no writer call for one case per group; git.test.ts, with untracked `a.md` and `[ab].md` in a real repository, commits only `[ab].md` through `commitFile`
- Issue: #15
- Status: done

### Decision log

## T5: Deterministic secret scrubber with fixtures
- Purpose: secrets are recognized and replaced in text and in frontmatter string values before anything can be committed
- Covers: R4.1, R4.2
- Size: M
- Depends on: none
- Files: src/vault/scrub/rules.ts, src/vault/scrub/index.ts, tests/scrub.test.ts, tests/fixtures/scrub/positive.json, tests/fixtures/scrub/negative.json
- Verify: `npm test -- tests/scrub.test.ts`, failing if any of these is false: (1) every rule in the exported list (private key block, AWS access key id, GitHub token, Slack token, Anthropic key, OpenAI key, Google API key, Stripe secret key, JWT, Bearer value, labeled password/secret/token/API key assignment, Luhn-valid card, IBAN) has at least one positive and one negative fixture; (2) 0 misses on positives, the output containing `[REDACTED:<rule>]` for the expected rule; (3) 0 matches on negatives, including digit runs that fail Luhn; (4) `scrub` returns `hits` per rule, is idempotent on redacted text, and picks the specific rule on overlap (`sk-ant-` is Anthropic, not OpenAI); (5) `scrubFrontmatter` replaces matches in every string value of a nested object, checks numbers and bigints as strings (a hit becomes the placeholder string) and leaves other non-strings untouched; (6) a rule that throws surfaces as `ScrubError`. Fixture secrets are synthetic.
- Issue: #16
- Status: done

### Decision log

## T6: Frontmatter validator driven by the vault config
- Purpose: new notes always carry valid type, area, date and source in the right folder
- Covers: R3.1, R3.2, R3.3, R3.4
- Size: S
- Depends on: T1
- Files: src/vault/validate.ts, tests/validate.test.ts
- Verify: `npm test -- tests/validate.test.ts`; asserts the error contract (code `invalid_frontmatter` or `wrong_folder`, missing owner property names, the property named, the expected folder with `{area}` expanded); owner-mapped property names; a type with no folder accepts any safe path; a missing or invalid area reports `invalid_frontmatter`, not a folder error
- Issue: #17
- Status: done

### Decision log

## T7: Re-read the vault config after each pull and reject an invalid one
- Purpose: the owner's config edits apply to the next write without a restart, and a broken config blocks writes with a clear 503 instead of a crash
- Covers: R2.3, R2.4
- Size: S
- Depends on: T1, T3
- Files: src/vault/write-note.ts, src/server/app.ts, src/index.ts, tests/notes.integration.test.ts, tests/app.test.ts
- Verify: `npm test -- tests/notes.integration.test.ts tests/app.test.ts`; a config with an unknown key and one with a wrong-typed value each give 503 `config_invalid` naming `.2brain/config.yaml` and the key path, with no commit and no file; an invalid config at startup does not exit the process; a commit pushed from `cloneElsewhere` that adds an area is accepted by the next create without a restart, where the same create was rejected before
- Issue: #18
- Status: done

### Decision log

## T8: Validate frontmatter on create and return 400
- Purpose: a create with missing, unknown or misplaced properties is rejected with a clear 400 and writes nothing
- Covers: R3.1, R3.2, R3.3, R3.4
- Size: S
- Depends on: T6, T7
- Files: src/vault/write-note.ts, src/server/app.ts, tests/notes.integration.test.ts, tests/app.test.ts
- Verify: `npm test -- tests/notes.integration.test.ts tests/app.test.ts`; through POST /notes: missing owner property names listed in 400 `invalid_frontmatter`; unknown type; unknown area; bad date; a path outside the type folder gives 400 `wrong_folder` with the expected folder; none leaves a file or a commit
- Issue: #19
- Status: done

### Decision log

## T9: Scrub secrets on create and report redactions
- Purpose: secrets are replaced before anything is written, the caller learns how many, and a scrubber failure writes nothing
- Covers: R4.1, R4.3, R4.4
- Size: S
- Depends on: T5, T8
- Files: src/vault/write-note.ts, src/server/app.ts, tests/notes.integration.test.ts, tests/app.test.ts
- Verify: `npm test -- tests/notes.integration.test.ts tests/app.test.ts`; a secret in the body and in a string frontmatter value is stored as `[REDACTED:<rule>]` and the 201 body has `redactions` as `{ rule, count }`; the log line holds only rule names and counts; an injected scrubber that throws gives 500 `scrub_failed`, no file and no commit
- Issue: #20
- Status: done

### Decision log

## T10: Idempotent create and source id dedupe
- Purpose: retries never create duplicates or false conflicts, including after a failed push or when the note arrived by pull
- Covers: R5.1, R5.2
- Size: M
- Depends on: T9
- Files: src/vault/source-index.ts, src/vault/write-note.ts, src/server/app.ts, tests/source-index.test.ts, tests/notes.integration.test.ts, tests/app.test.ts
- Verify: `npm test -- tests/source-index.test.ts tests/notes.integration.test.ts tests/app.test.ts`; each case fails before the change: (a) the same create twice returns 201 then 200 `unchanged: true` with `commit: null` and one commit in the log; (b) a create whose commit stayed local after a failed push, retried, returns 200 `unchanged`, not 409 (since T12: 502 `push_pending` while the push still fails, 200 `unchanged` once it lands); (c) a path that exists only on the remote with identical bytes returns 200 `unchanged`, with different bytes 409 `note_exists`; (d) a different path whose `source_id` belongs to another note returns 409 `duplicate_source` with that path and writes nothing; (e) a retry of the same note (same path and `source_id`) returns 200 `unchanged`, not `duplicate_source`; (f) a `source_id` from a note that arrived with the pull, or from the service's own earlier commit, is found (index rebuilt when HEAD changes); (g) the index uses the owner's `source_id` name, ignores `.git/`, and skips notes without it; (h) if the commit fails, the file written by this call is removed
- Issue: #21
- Status: done

### Decision log

## T11: Keep both versions on a rebase conflict
- Purpose: a conflicting edit from the PC never blocks the vault and never loses either version
- Covers: R8.1, R8.2
- Size: M
- Depends on: T9
- Files: src/git/sync.ts, src/git/index.ts, src/vault/write-note.ts, tests/sync.integration.test.ts
- Verify: `npm test -- tests/sync.integration.test.ts`; with an unpushed local commit and a conflicting remote commit (built with the fixture's `git()` and `cloneElsewhere`): the rebase is aborted, the local version is kept as `<name> (conflict YYYY-MM-DD).md` next to the remote version (date from an injected clock), both reach the remote, the log carries only the count, and the original request completes; afterwards no `.git/rebase-merge` or `.git/rebase-apply` exists and the next write succeeds; a pull failure that is not a conflict still gives 500 `write_failed`
- Issue: #22
- Status: done

### Decision log

## T12: Retry pushes and deliver pending commits
- Purpose: a network failure never strands a note on the server
- Covers: R8.3, R8.4
- Size: M
- Depends on: T10, T11
- Files: src/git/sync.ts, src/vault/write-note.ts, src/server/app.ts, tests/sync.integration.test.ts, tests/notes.integration.test.ts, tests/app.test.ts
- Verify: `npm test -- tests/sync.integration.test.ts tests/notes.integration.test.ts tests/app.test.ts`; a push that succeeds on a retry gives 201 and the injected waits are exactly 1000, 2000 and 4000 ms in order; a push that always fails (zero injected waits) gives 502 `push_pending` with the local commit id, and body, logs and error carry no URL marker (D19 updated and kept); after a `push_pending`, a write to another path pushes both commits; a write that makes no commit while the branch is ahead still pushes the pending commit
- Issue: #23
- Status: done

### Decision log

## T13: PATCH /notes to set properties
- Purpose: people, topics and projects get updated instead of duplicated, and secrets in the new values never reach Git
- Covers: R6.1, R6.4, R6.5, R4.1
- Size: M
- Depends on: T12
- Files: src/vault/operations.ts, src/vault/note-schema.ts, src/vault/write-note.ts, src/server/app.ts, tests/patch.integration.test.ts, tests/app.test.ts
- Verify: `npm test -- tests/patch.integration.test.ts tests/app.test.ts`; on a real bare remote: `PATCH {path, set}` merges properties, leaves the body byte-identical, commits `2brain: update <path>`, pushes through the retrying push, and returns 200 with a commit id; a push that always fails (zero injected waits) returns 502 `push_pending` with the local commit id; a missing path returns 404 `note_not_found`; a `set` equal to the current values on a hand-formatted note returns 200 `unchanged: true` with `commit: null` and leaves the file bytes untouched; a `set` that makes the result invalid returns 400 `invalid_frontmatter` (unknown type, bad date) or `wrong_folder` (type changed so the path is outside its folder) with file and HEAD unchanged; an invalid config returns 503 `config_invalid` with no commit; a fixture secret in a `set` string value (also inside a nested object) is stored as `[REDACTED:<rule>]` and the 200 body has `redactions` as `{ rule, count }`, and an injected throwing scrubber returns 500 `scrub_failed` with file and HEAD unchanged; a body with `append` or without `set` returns 400 `invalid_body` (until T14); path-rule violations (`../x.md`, a backslash, a leading `:`) return 400, and a symlink at the target pointing outside the vault, and a parent directory symlinked outside the vault, each return 400 with the outside file untouched; PATCH returns 415 for non-JSON and 413 above 1 MiB
- Issue: #24
- Status: done

### Decision log
## T14: Append text with PATCH, respecting immutable bodies
- Purpose: new information is added to a note without touching what it already says, secrets in the added text never reach Git, and transcripts never change
- Covers: R6.2, R6.3, R4.1
- Size: S
- Depends on: T13
- Files: src/vault/operations.ts, src/vault/note-schema.ts, src/server/app.ts, tests/patch.integration.test.ts, tests/operations.test.ts, tests/app.test.ts
- Verify: `npm test -- tests/patch.integration.test.ts tests/operations.test.ts tests/app.test.ts`; (a) append to a body with and without a trailing newline yields the old bytes, one blank line, then the new text, earlier bytes compared byte for byte, commit and push on the remote; (b) append to a type with `immutable_body: true` returns 409 `immutable_body`, file unchanged, no commit; (c) `set` alone on that note returns 200; (d) `set` plus `append` on it returns 409 and writes nothing; (e) the rule is read from the config under the owner's `type` name; (f) appended text with a fixture secret is stored redacted and the response carries `redactions`; (g) a throwing scrubber gives 500 `scrub_failed`; (h) an empty append returns 200 `unchanged`; the T13 test that expected 400 for `append` is changed to expect success
- Issue: #25
- Status: todo

### Decision log

## T15: Archive instead of delete
- Purpose: removing a note moves it to the archive folder and nothing is ever lost
- Covers: R7.1, R7.2, R7.3
- Size: M
- Depends on: T14
- Files: src/vault/operations.ts, src/vault/note-schema.ts, src/vault/write-note.ts, src/git/index.ts, src/server/app.ts, tests/archive.integration.test.ts, tests/app.test.ts
- Verify: `npm test -- tests/archive.integration.test.ts tests/app.test.ts`; (a) on a real bare remote, an existing note moves to `<archive folder>/<original path>` byte-identical, the commit `2brain: archive <path> -> <new path>` reaches the remote through the retrying push, and the response is 200 with the new path; (b) a note already in the archive folder gives 409 `already_archived` and an existing target gives 409 `archive_target_exists`, files and HEAD unchanged; (c) a missing note gives 404 `note_not_found`; (d) if the commit fails after the move, the note is back at its path and nothing is left at the target; (e) a push that always fails (zero injected waits) gives 502 `push_pending` with the local commit id, the move stays committed locally, and the next write pushes it; (f) an invalid config gives 503 `config_invalid` with no move and no commit, and a path that breaks the path rules gives 400 with no git command; (g) the router exposes no DELETE route and a source scan finds no `unlink`, `rm` or `rmdir` on vault paths; a config with a non-default `archive_folder` moves the note there
- Issue: #26
- Status: todo

### Decision log
## T16: init-vault command
- Purpose: a new owner can seed a vault directory from the template without overwriting anything
- Covers: R9.2
- Size: S
- Depends on: T1
- Files: src/cli.ts, tests/cli.integration.test.ts
- Verify: `npm test -- tests/cli.integration.test.ts`; the CLI exports `main(argv, io)` that returns the exit code and resolves the template as `../vault-template` relative to `import.meta.url` (same relative path from `src/cli.ts` and `dist/cli.js`); `init-vault <dir>` on a missing and on an empty directory copies every template file including `.2brain/config.yaml` (tree compared with the template); on a directory with some of those files it copies only the missing ones, leaves existing bytes unchanged and prints the skipped paths; on a path that is a file it returns 1 and writes nothing; a second run copies nothing
- Issue: #27
- Status: done

### Decision log

## T17: Template in the image and compose healthcheck
- Purpose: the built image contains the template next to the CLI, and Docker reports a crashed service
- Covers: R9.2, R10.1
- Size: S
- Depends on: T16
- Files: Dockerfile, compose.yaml, tests/compose.test.ts
- Verify: `npm test -- tests/compose.test.ts`; the test parses compose.yaml with `parseYamlConfig` and asserts that service `brain` has a `healthcheck` whose `test` runs `node -e` with a fetch of `/health` using `process.env.PORT` with 3000 as fallback, plus `interval`, `timeout` and `retries`; it reads the Dockerfile and asserts that the final stage copies `vault-template` to `/app/vault-template` so `/app/dist/cli.js` resolves `../vault-template`; both fail on today's files; `docker-build` CI stays green
- Issue: #28
- Status: done

### Decision log
