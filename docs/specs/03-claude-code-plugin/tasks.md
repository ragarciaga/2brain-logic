# Tasks: Claude Code plugin
Spec: docs/specs/03-claude-code-plugin/  |  Status: approved  |  Converged: 2026-10-31, 1 round, not converged

<!--
Field names and statuses stay in canonical English (parsed strictly by `rb tasks`; unknown keys
or statuses are errors). Statuses: todo, in-progress, in-review, done, blocked.
Builds on F1 and F2 (merged): no skeleton task. Order: service additions first (T1 `vault_info`,
T2 `session` type), because the plugin's headless session and skill read them; then the plugin
package, its pure libraries, the hook, the headless runner, the worker, the skill, the docs, and
last the manual checks on the owner's machines.
Tier C tasks named by design.md Risk and cost stay alone: T1 (`vault_info` on the public MCP app),
T2 (`session` type in config defaults and vault-template), T4 (marketplace file, plus the
package.json lint script, which `rb risk` treats as tier C), T11 to T14 (headless runner argv,
env, spawn and capture prompt).
Plugin scripts are plain ESM JavaScript (`.mjs`, Node built-ins only, R1.4), type checked by
`tsc --checkJs` through tsconfig.json and tested by Vitest from `tests/plugin/*.test.ts`.
Until T4 is merged, every task that adds or changes files under plugin/ also runs
`npx biome check plugin` before it opens its PR, so T4's lint stays green.
The owner-data, import and network scans live in tests/plugin/helpers/plugin-scan.ts with the
fictional name list tests/plugin/fixtures/person-names.json (both created by T3); T4, T14 and T19
reuse them.
Integration tests use a fake `claude` (tests/plugin/fixtures/fake-claude.mjs, created by T13; T17
extends it with a hook-fire mode) put first on a temp PATH: it records argv, stdin, env, pid and
start and end times, and returns scripted results.
Manual criteria are grouped by what the owner runs in one sitting (T21 to T26, each an
`rb:needs-local` issue); 18 manual criteria at most 4 per task, in six sittings.
-->

## T1: Add the read-only `vault_info` MCP tool
- Purpose: the headless capture session and the meeting skill learn the owner's areas, types, folders and property names over MCP, since `read` refuses `.2brain/`
- Covers: R10.1, R10.2
- Size: M
- Depends on: none
- Files: src/mcp/tools/info.ts, src/mcp/tools/read.ts, src/mcp/server.ts, tests/mcp-info-tool.test.ts, tests/mcp-info.integration.test.ts, tests/mcp-write-tools.test.ts, docs/GUIDE-mcp.md, tests/guide-mcp.test.ts
- Verify: `npm test -- tests/mcp-info-tool.test.ts tests/mcp-info.integration.test.ts tests/mcp-read-tools.test.ts tests/mcp-write-tools.test.ts tests/mcp-endpoint.test.ts tests/guide-mcp.test.ts`; `npm run typecheck`; info.ts reuses the read tools' `guarded` and `toResult` (exported from read.ts, with the outcome union widened), so the config is loaded inside `withPulled` after the pull, the same way the other read tools load it; unit: with no `.2brain/config.yaml` the answer is `{ ok: true, areas, properties, types, archive_folder }` built from `DEFAULT_VAULT_CONFIG` (the expected `types` derived from `DEFAULT_VAULT_CONFIG.types`, not hard-coded, so T2 can merge before or after), where `types` has one `{ key, value, folder }` per configured type in declaration order, and the top-level keys and each type's keys are exactly those; a fixture config with `sources`, `inbox_folder`, `immutable_body` and one type without `folder` gives `folder: null` for that type and none of `sources`, `inbox_folder`, `immutable_body` or `version`; a marker env value and a marker server setting set in the test are absent from the serialized answer, and so is a marker string written in a note body; when the pull fails the answer only gains `stale: true`; an invalid `.2brain/config.yaml` answers `{ ok: false, error: "config_invalid" }` with `isError` true, and a config file that cannot be read (a directory in its place, or mode 000 on POSIX, skipped on Windows) answers `{ ok: false, error: "internal_error" }`, neither containing a path or key text; the tool's listed `inputSchema` has no properties, and a call with an unexpected argument is still answered; integration: through the SDK v2 client against a fixture vault, `listTools` equals `search, read, recent, save_note, save_recipe, update_properties, vault_info` (the registry test in mcp-write-tools.test.ts is updated, with `WRITE_TOOLS` and `READ_TOOLS` unchanged, and no tool name matches delete, move, archive, remove or rename), and a call returns the fixture's areas, renamed property names and type folder patterns; docs/GUIDE-mcp.md says seven tools, has a `vault_info` bullet stating it is read only, and no longer says six tools, and guide-mcp.test.ts checks all three; the guide has no em dash
- Issue: #89
- Status: done

### Decision log
- Round 1: `read.ts` added to Files so `guarded`, `toResult` and `fail` are shared, not copied; `stale`, `internal_error`, defaults and no-input cases added.

## T2: Add the canonical `session` type to the default config and vault template
- Purpose: session notes have a type and a folder in every new vault, the same in code and template
- Covers: R10.3
- Size: S
- Depends on: none
- Files: src/config/defaults.ts, vault-template/.2brain/config.yaml, vault-template/personal/sessions/README.md, vault-template/work/sessions/README.md, tests/template.test.ts, tests/vault-config.test.ts
- Verify: `npm test -- tests/template.test.ts tests/vault-config.test.ts`; `npm run typecheck`; `npm run lint`; `DEFAULT_VAULT_CONFIG.types.session` is exactly `{ value: "session", folder: "{area}/sessions" }`, added as the last key after `review` in both src/config/defaults.ts and vault-template/.2brain/config.yaml (`session: { value: session, folder: "{area}/sessions" }`); the existing test that keeps vault-template/.2brain/config.yaml strictly equal to `DEFAULT_VAULT_CONFIG` passes; the `expandTypeFolders` default-order test in tests/vault-config.test.ts is updated to end with "reviews", "personal/sessions", "work/sessions"; the README-per-folder and "only the config and one README.md per folder" tests find `personal/sessions/README.md` and `work/sessions/README.md`; each README is exactly `# <area> sessions`, a blank line, and `One note per AI work session in this area.` (no proper nouns, so the template owner-data scan passes); the existing test "replaces the default types and areas when the file sets them" still passes, showing a config that lists `types` without `session` loads unchanged (no migration); neither README contains the em dash character
- Issue: #90
- Status: done

### Decision log
- Round 1: reviewer verdict was keep with an amended Verify; the amended Verify is applied (key order, the `expandTypeFolders` list, exact README text).

## T3: Create the plugin package: manifest, hooks config, settings reader and package checks
- Purpose: `plugin/` is a loadable Claude Code plugin named `2brain` with its settings, and every later plugin file is held to the no-owner-data, built-ins-only and no-network rules by one shared scanner that T4, T14 and T19 reuse (the `analizar-reunion` part of R1.1 is T19)
- Covers: R1.1, R1.3, R1.4, R8.10
- Size: M
- Depends on: none
- Files: plugin/.claude-plugin/plugin.json, plugin/hooks/hooks.json, plugin/scripts/lib/settings.mjs, tsconfig.json, tests/plugin/helpers/plugin-scan.ts, tests/plugin/fixtures/person-names.json, tests/plugin/package.test.ts, tests/plugin/settings.test.ts
- Verify: `npm test -- tests/plugin/package.test.ts tests/plugin/settings.test.ts`; `npm run typecheck`; `npm run lint`; `npm run build`; tsconfig.json adds `plugin` to `include` with `allowJs` and `checkJs`; tsconfig.build.json still builds only `src`; a type error planted in a scratch copy of settings.mjs makes `npm run typecheck` fail (checked once by hand, noted in the Decision log); package.test.ts: plugin.json has `name` `2brain`, a semver `version`, no `author`, `homepage` or `repository`, and `userConfig` with exactly `area` (string, not required, no default), `server_name` (string, default `brain`), `model` (string, default `sonnet`), `min_user_prompts` (number, default 3), `note_language` (string, default `en`) and `enabled` (boolean, default true), each with a `title` and a `description`; every default in plugin.json equals the value `readSettings({})` returns; hooks.json has only the `SessionEnd` event with one entry, no matcher, and one hook with `type` `command`, `command` `node` and `args` `["${CLAUDE_PLUGIN_ROOT}/scripts/session-end.mjs"]` (the script itself is asserted by T10); `plugin/` has no package.json and no node_modules; plugin-scan.ts exports `scanOwnerData(text)`, `scanImports(text)` and `scanNetwork(text)`, each returning the matches it found, and package.test.ts runs all three over every file under `plugin/` and expects none; scanOwnerData flags any email address not at `example.com`, any URL host and any bare hostname ending in .com, .net, .org, .io, .co, .dev, .app or .ai other than `example.com`, any name from tests/plugin/fixtures/person-names.json (fictional names only), and any vault path whose first segment is neither an area from `src/config/defaults.ts` (imported, not copied) nor `{area}`, plus a denylist of fictional fixture areas and folders; scanImports flags any static `import`, dynamic `import()` or `require` whose specifier does not start with `node:`; scanNetwork flags `node:http`, `node:https`, `node:http2`, `node:net`, `node:tls`, `node:dgram`, `fetch(`, `new WebSocket`, `new EventSource`, `XMLHttpRequest`, `git` as the command of `spawn`/`execFile`/`exec`/`execSync`/`execFileSync`, and references to `.2brain` or `VAULT_`; every rule has a planted in-memory sample that the scanner catches and a clean sample (for example `process.execPath`, `settings.server_name`, `{area}/sessions`) that it does not flag; planted hosts use `.test` or `example.org`; settings.test.ts: `readSettings(env)` reads `CLAUDE_PLUGIN_OPTION_<KEY>` with KEY upper-cased (D2; confirm against the docs, note it in the Decision log, re-checked by hand in T21); `enabled` is false only for `false` or `0` (case-insensitive) and true when unset or empty; `min_user_prompts` takes a non-negative integer string and falls back to 3 when the value is empty, not a number, negative or fractional; an empty or unset string option takes its default, except `area`, which stays `""`; unknown `CLAUDE_PLUGIN_OPTION_*` keys and other env vars are ignored; `TWOBRAIN_AREA` is not read here (T9)
- Issue: #91
- Status: done

### Decision log
- Round 1: the shared scanner lives in tests/plugin/helpers/plugin-scan.ts (T4 proposed tests/plugin/owner-scan.ts and T19 tests/plugin/helpers/owner-data.ts for the same thing; T3's own reviewer gave the concrete rules, so its path wins and T4 and T19 import it). Tier B: tsconfig.json is not a floor path; the package.json lint change stays in T4.
- Implementation: a type error planted in a scratch copy of settings.mjs (`/** @type {number} */ ("x")`) made `npm run typecheck` fail with TS2352; removed afterwards. D2 env key casing from design.md, re-checked in T21.

## T4: Add the marketplace file and lint the plugin scripts
- Purpose: a third party can add this repository as a marketplace and install `2brain`, and the plugin scripts and marketplace file are linted like the rest of the code
- Covers: R1.2
- Size: S
- Depends on: T3
- Files: .claude-plugin/marketplace.json, package.json, tests/plugin/marketplace.test.ts
- Verify: `npm test -- tests/plugin/marketplace.test.ts`; `npm run lint`; marketplace.test.ts: .claude-plugin/marketplace.json parses as JSON with a string `name`, `owner` equal to `{ "name": "2brain-logic" }` (no email, no url) and exactly one entry in `plugins` with `name` `2brain`, `source` `./plugin` and no `version` key (plugin/.claude-plugin/plugin.json is the only version, D19); the source resolved from the repository root is a directory holding `.claude-plugin/plugin.json` whose `name` is `2brain`; the repository root `.claude-plugin/` holds no plugin.json; `scanOwnerData` from tests/plugin/helpers/plugin-scan.ts (T3) finds nothing in marketplace.json; the package.json diff changes only `scripts.lint`, which becomes `biome check src tests evals plugin .claude-plugin vitest.config.ts vitest.evals.config.ts`, and package-lock.json is unchanged
- Issue: #92
- Status: done

### Decision log
- Round 1: kept as one tier C task (marketplace plus lint script, one escalation). The other plugin tasks run `npx biome check plugin` until this merges (header rule) instead of depending on it.

## T5: Build the job queue and the local capture log
- Purpose: jobs are stored privately and atomically, retried a bounded number of times, and every capture event leaves one content-free log line
- Covers: R8.6, R8.7, R8.8, R8.9
- Size: M
- Depends on: T3
- Files: plugin/scripts/lib/queue.mjs, plugin/scripts/lib/log.mjs, tests/plugin/queue.test.ts, tests/plugin/log.test.ts
- Verify: `npm test -- tests/plugin/queue.test.ts tests/plugin/log.test.ts`; `npm run typecheck`; queue.test.ts (temp data dir, injected clock and logger): `enqueue(event)` writes `queue/<epoch ms>-<session id>.json` through a `.tmp` file and a rename, with `{ version: 1, event, attempts: 0, createdAt }` where `event` keeps only `session_id`, `transcript_path`, `cwd`, `hook_event_name` and `reason` (an extra field carrying planted text is absent from the file), with mode 0600 on POSIX (checked with `statSync`, skipped on Windows); a session id not matching `^[A-Za-z0-9_-]{1,128}$` (for example `../x`) is rejected and nothing is written outside `queue/`; `list()` returns jobs oldest first and ignores `.tmp` files; `recordAttempt(job)` increases `attempts` by one and keeps mode 0600; `remove(job)` deletes it; `sweep()` moves a job with `attempts >= 3`, one with `createdAt` more than 7 days before the clock, and one that is not valid JSON to `failed/`, logging `gave_up` for each, and deletes files in `failed/` older than 30 days; a job with 2 attempts created 6 days ago stays; log.test.ts (temp data dir, injected clock): `log(sessionId, code, fields)` appends one line `<ISO time> <id8> <code>[ exit=<n>][ notes=<paths joined by ",">][ recipes=<n>]` to `logs/capture.log`, and `saved` with one note and `recipes: 1` equals the design.md example; a code not matching `^[a-z_]+$` is rejected; fields other than `exit`, `notes` and `recipes`, given planted transcript text, a prompt, an env value and a token, appear nowhere in the file; when `capture.log` is already at least 1048576 bytes, the next write renames it to `capture.log.1` (replacing an older one) and the line starts a new `capture.log`
- Issue: #93
- Status: done

### Decision log
- Round 1: the log takes a fixed field allowlist (`exit`, `notes`, `recipes`) so design.md's `headless_failed exit=<n>` fits and nothing else can leak; `recordAttempt` and `sweep` added so T15 to T18 do not invent queue APIs.

## T6: Build the transcript digest
- Purpose: the capture sees a bounded, faithful digest of what happened in the session (or only its new part when resumed), and the worker can count real user prompts and recognize a resumed session
- Covers: R4.2, R5.1, R5.2, R5.3
- Size: M
- Depends on: T3
- Files: plugin/scripts/lib/digest.mjs, tests/plugin/digest.test.ts, tests/plugin/fixtures/transcript-basic.jsonl, tests/plugin/fixtures/transcript-noise.jsonl
- Verify: `npm test -- tests/plugin/digest.test.ts`; `buildDigest(lines, opts)` returns `{ text, userPrompts, lineage, lastDate }`; on the basic fixture the text keeps user prompts, assistant text, each tool call's name with its command or file path, and only the first 2,000 characters of each tool result (two 5,000 character results in one fixture are each cut to 2,000); `userPrompts` counts only real user prompts: user entries made only of `tool_result` blocks, `isMeta: true` entries, `isSidechain: true` entries and content starting with `<command-name>`, `<local-command-stdout>` or `<local-command-stderr>` are not counted; `lineage` is the `uuid` of the first counted user prompt (a meta entry placed before it does not change it); `lastDate` is the `YYYY-MM-DD` of the last entry's `timestamp` in `opts.timeZone` (default the machine's local zone), so `2026-11-01T02:00:00Z` with `America/Bogota` gives `2026-10-31`; with `opts.fromPrompt: n` the text starts at user prompt n+1 and holds no earlier entry, while `userPrompts`, `lineage` and `lastDate` still describe the whole transcript; a digest of exactly 150,000 characters is unchanged, and a 200,000 character digest becomes the first 30,000 and the last 120,000 characters with one marker line stating 50,000 characters were left out; `transcript-noise.jsonl` is `transcript-basic.jsonl` with invalid JSON lines and unknown shapes interleaved and yields the same result as the basic fixture
- Issue: #94
- Status: done

### Decision log
- `lastDate` uses the local calendar date (injectable `opts.timeZone`), since the note date is the owner's day, not the UTC day.
- `opts.fromPrompt` is where T8's prompt offset is applied, so R4.6 "capture only the new part" has an owner; T15 passes T8's offset through.
- Round 1: the reviewer's proposal to add R4.6 to Covers was not applied (it would make 5 criteria, over the limit of 4); R4.6 stays covered by T8 and is wired in T15.
- T9 hardening (issue #97): U+001C to U+001E count as line breaks; a mid-line tail after the cut is always indented, whatever it starts with; heredoc parsing accepts `<<1`, `<<.END`, `<< -EOF`, `<<$'EOF'` and several heredocs per command, and a `<<` with no readable word drops the rest of the command.

## T7: Build the progress reader and the pre-scrub
- Purpose: the capture gets a bounded, read-only copy of the project's progress file, and never sees secret-shaped strings from it or from the digest
- Covers: R5.4, R5.6
- Size: M
- Depends on: T3
- Files: plugin/scripts/lib/progress.mjs, plugin/scripts/lib/scrub.mjs, tests/plugin/progress.test.ts, tests/plugin/scrub.test.ts
- Verify: `npm test -- tests/plugin/progress.test.ts tests/plugin/scrub.test.ts`; `npm run typecheck`; progress.test.ts: `readProgress(cwd)` returns the design.md header line `--- progress.md (first 20,000 characters) ---`, a newline and the file text, or `null` (T9 places this string unchanged); a regular `docs/progress.md` in a temp `cwd` of 50,000 characters including multi-byte and astral characters gives exactly its first 20,000 characters with no split surrogate pair, and the reader reads at most 80,000 bytes (a 10 MiB file is not read whole, checked by spying on the read or by timing under 200 ms); a missing file, a directory named `docs/progress.md`, a missing `cwd`, a `docs/progress.md` symlink resolving outside `cwd` and a `docs/` symlink resolving outside `cwd` give `null`; a symlink resolving to a regular file inside `cwd` gives its text, and so does a `cwd` that is itself a symlink to the temp tree (containment is checked on `realpath` of both); symlink cases are skipped on Windows; the temp tree's file list, sizes and mtimes are unchanged after every case, and a source scan of progress.mjs finds no `writeFile`, `appendFile`, `mkdir`, `rm`, `unlink`, `rename`, `copyFile`, `createWriteStream`, `utimes` or an `open` flag other than `r` (the scan fails on a planted sample); scrub.test.ts: `preScrub(text)` returns `{ text, count }` and a table checks exact output and count for: a complete private key block (whole block to `[redacted]`, count 1), a private key block with no END line (redacted from BEGIN to the end of the text), `Authorization: Bearer <token>` (token redacted, `Bearer` kept), the assignment forms `API_KEY=v`, `export GITHUB_TOKEN=v`, `db_password: v`, `MY_SECRET="v w"`, `{"apiKey": "v"}` and `--password v` (name matched without regard to case, only the value replaced, name kept), and tokens with well-known prefixes and minimum body lengths (`sk-ant-`, `ghp_`, `github_pat_`, `xoxb-`, `AKIA` plus 16 uppercase letters or digits) each replaced with `[redacted]`; a text holding all of them reports the sum; running preScrub twice yields the same text and count 0 the second time; a negative table is unchanged with count 0: plain prose, `keyboard layout: qwerty`, a 40-character git sha, a UUID, the bare words `AKIA`, `ghp_` and `sk-ant`, and `Bearer` in prose with no token; a 200,000-character hostile input (an unterminated BEGIN line followed by 199,000 `A`, and 50,000 repeats of `KEY=`) completes in under 500 ms; the rules are a fixed list in scrub.mjs with no import from `src/` (the T3 import scan passes)
- Issue: #95
- Status: done

### Decision log
- Review: the progress header is owned here so R5.4 ("marked as the project's progress file") is covered in one task; T9 only places the string. Redaction keeps assignment names and the `Bearer` word so the capture can still describe the setup step; values only are replaced. Unterminated key blocks are redacted to the end because T6 cuts tool results at 2,000 characters. R5.5 stays with T17 [integration]; the write API scan here is a unit-level check for design.md's read-only rule.
- Round 1: the proposed negative case `monkey=banana` was dropped: R5.6 says names that contain KEY, so that name is in scope for redaction. Size raised from S to M for the added cases.

## T8: Build the capture state, dedupe and part numbering
- Purpose: one session is captured once, and a resumed session with real new work is captured as a numbered part of the same conversation
- Covers: R4.4, R4.5, R4.6, R4.7
- Size: M
- Depends on: T3
- Files: plugin/scripts/lib/state.mjs, tests/plugin/state.test.ts
- Verify: `npm test -- tests/plugin/state.test.ts`; `npm run typecheck`; all with a temp data dir and an injected clock: `readState(dataDir)` reads `<dataDir>/state.json` and returns `{ version: 1, sessions: {} }` for a missing, unreadable, non-JSON or wrong-version file; `decide(state, { sessionId, lineage, userPrompts, minUserPrompts })` returns `{ action: "capture", part: 1, sourceId: "claude-code:<session id>", idForName: <session id>, fromPrompt: 0 }` for an unknown session id and lineage; returns `{ action: "skipped_duplicate" }` for a known session id with fewer than `minUserPrompts` new prompts (userPrompts minus the stored prompts), and the same for a known lineage under a new session id; returns `{ action: "capture", part: n, sourceId: "claude-code:<first session id>:<n>", idForName: <first session id>, fromPrompt: <stored prompts> }` with n = stored parts + 1 when at least `minUserPrompts` new prompts exist, both for the same session id resumed and for a known lineage under a new session id, where <first session id> is the key of the entry that first captured that lineage; a null or empty lineage never matches another entry; `recordCapture(dataDir, { sessionId, lineage, userPrompts, part }, now)` writes `{ version: 1, sessions: { <id>: { lineage, prompts, parts, capturedAt } } }`, updates the existing entry of a known session or lineage (prompts = userPrompts, parts = part, capturedAt = now) instead of adding a second one, so a following `decide` gives part n+1 with the new offset; on every write, entries with capturedAt older than 180 days before now are pruned; after an unreadable or wrong-version file, `recordCapture` replaces it with a valid version 1 file holding only the new entry; the state file holds no transcript text
- Issue: #96
- Status: done

### Decision log
- Parts number per lineage: a resumed session under a new id continues the entry that first captured its lineage, and its source id and file-name id use that first session id, so all parts of one conversation share `claude-code:<first id>` and one id8 (R4.6, design.md Idempotency).

## T9: Build the capture input and the note file name
- Purpose: the headless session gets one plain-text request with the exact note file name, the area, the language and the scrubbed content, and no other environment value
- Covers: R5.8, R7.1, R8.1
- Size: S
- Depends on: T3, T7
- Files: plugin/scripts/lib/input.mjs, tests/plugin/input.test.ts
- Verify: `npm test -- tests/plugin/input.test.ts`; `noteFileName({ lastDate, cwd, sessionId, part })` gives `<YYYY-MM-DD> <project> <id8>.md`, where the date is `lastDate` as given (the T6 value), the project is the last non-empty segment of `cwd` for POSIX and Windows paths, trailing separators included, and id8 is the first 8 characters of the session id (T15 passes T8's `idForName`); part 1 has no suffix and part 2 gives `... <id8> part 2.md`; a project segment with characters that F1 `NotePath` rejects (`<>:"|?*`, control characters, trailing dot or space) has each one replaced with `-`, and every name the table produces passes `NotePath` from src/vault/note-schema.ts; `buildInput({ area, language, lastDate, cwd, sessionId, sourceId, part, progress, digest })` takes no env argument and returns the CAPTURE REQUEST header of design.md in order (area, language, date, project, source_id and part as given by T8, then the line `note path: <session folder for area>/<file name>`, with the placeholder text kept literally), then the progress string from `readProgress(cwd)` (T7) unchanged when it is not null (omitted when null), then the digest; `preScrub` runs on the progress text and on the digest after T6's cut, and a planted secret in `progress` and one in `digest` both come out as `[redacted]` while the header lines are not scrubbed; `resolveArea(env, settings)` returns trimmed `TWOBRAIN_AREA` when it is non-empty, else the trimmed `area` setting, else `not_configured`; with every variable in a copy of `process.env` set to a unique marker, read through `readSettings` and `resolveArea` and passed to `buildInput`, only the `TWOBRAIN_AREA` and `CLAUDE_PLUGIN_OPTION_NOTE_LANGUAGE` markers appear, each only on its `area:` or `language:` field, and no other marker appears
- Issue: #97
- Status: done

### Decision log
- Project segment sanitizing (replace F1 NotePath-unsafe characters with `-`) added at review: design.md says only "last segment of cwd", and an unsafe name would fail save_note on every retry until gave_up. This is consistent with F1 path rules and is not a new behavior decision.
- The worker never resolves the session folder (R8.10, no vault access). Per design.md, the headless session joins the file name to the folder it gets from vault_info.
- Round 1: Depends narrowed from T6, T7, T8 to T3, T7 (buildInput takes plain values; T15 does the wiring).
- Progress keeps its header line, but its body is scrubbed and indented, so no progress or transcript text starts a column-0 line that looks like a header, separator or label; this supersedes "unchanged" in Verify, "T9 only places the string" in the T7 log and "(T9 places this string unchanged)" in the T7 Verify. Digest lines that are not T6 builder labels are indented too.
- `buildInput` throws `Error("invalid_field:<name>")` for an invalid header field, including a null `lastDate`; T15 must catch it, log it and drop the job. `NOT_CONFIGURED` is exported and compared by constant. The design.md parenthetical about joining the file name to the folder is not placed in the input; capture.md (T14) explains it.

## T10: Build the SessionEnd hook
- Purpose: exiting Claude Code stores the event and returns at once, silently, and never captures a capture run
- Covers: R2.3, R2.4, R2.5, R3.2
- Size: S
- Depends on: T5
- Files: plugin/scripts/session-end.mjs, tests/plugin/hook.test.ts
- Verify: `npm test -- tests/plugin/hook.test.ts`; session-end.mjs exports `runHook(stdinText, env, deps)` (deps: `spawn`, `enqueue`, `log`, defaulting to `node:child_process` spawn and the T5 queue and log) and calls it only when run as the main module; in-process with injected deps: a valid SessionEnd event stores exactly one job whose `event` equals the input and calls `spawn` once with `process.execPath`, argv exactly `[<scripts dir>/capture-worker.mjs, <job dir as in design.md Interfaces>]`, the env passed through unchanged, and options `detached: true`, `stdio: "ignore"`, `shell: false`, `windowsHide: true`, then `unref()` on the child; with `TWOBRAIN_CAPTURE=1` or `CLAUDE_PLUGIN_OPTION_ENABLED=false`, neither `enqueue`, `spawn` nor `log` is called; a `spawn` that throws logs `hook_error`, leaves the job file in `queue/` and returns exit code 0; as a child process run with `process.execPath` and a temp `CLAUDE_PLUGIN_DATA` (no case here reaches the worker spawn): input that is not JSON, or lacks `session_id`, `transcript_path` or `cwd`, logs `invalid_input` in `logs/capture.log`, leaves `queue/` empty and exits 0; with `TWOBRAIN_CAPTURE=1` or `CLAUDE_PLUGIN_OPTION_ENABLED=false` it exits 0 and the data directory stays empty (no job, no log line); with `queue` created as a regular file inside the data directory it logs `hook_error` and exits 0; with `CLAUDE_PLUGIN_DATA` pointing at a regular file, or unset, it exits 0 and writes nothing; in every child-process case stdout and stderr are empty (these cases avoid chmod so they hold when run as root and on Windows); the job file records the resolved area (`TWOBRAIN_AREA` from the hook environment, else the `area` setting) at hook time (design.md Decision log)
- Issue: #98
- Status: done

### Decision log
- Review: success path and spawn-failure case added; in-process vs child-process split made explicit because the real worker (T15) does not exist yet and the child-process happy path is T17's; read-only directory replaced by file-in-place-of-directory cases that fail the same way as root and on Windows.

## T11: Build the headless invocation arguments and result schema
- Purpose: the capture session can only use the six brain tools, without prompts, on a fixed model, turn limit and output shape
- Covers: R3.3, R6.1, R6.2, R6.3
- Size: S
- Depends on: T3
- Files: plugin/scripts/lib/headless.mjs, plugin/prompts/result.schema.json, tests/plugin/headless-argv.test.ts
- Verify: `npm test -- tests/plugin/headless-argv.test.ts`; `npm run typecheck`; `buildInvocation(settings, env, paths)` with `paths = { pluginRoot, dataDir }` returns `argv` strictly equal (same elements, same order) to: `"-p"`, `"--tools"`, `""` (an empty string element, not the characters `""`), `"--allowedTools"`, one element that is `mcp__<server_name>__vault_info,mcp__<server_name>__search,mcp__<server_name>__read,mcp__<server_name>__save_note,mcp__<server_name>__save_recipe,mcp__<server_name>__update_properties` joined by commas in that order (checked for the default `brain` and for a custom `server_name`), `"--permission-mode"`, `"dontAsk"`, `"--permission-prompts"`, `"none"`, `"--model"`, the `model` setting (checked for the default `sonnet` and a custom value), `"--max-turns"`, `"20"`, `"--output-format"`, `"json"`, `"--json-schema"`, the exact text of plugin/prompts/result.schema.json as read from disk, `"--append-system-prompt-file"`, `path.join(pluginRoot, "prompts", "capture.md")` (the file need not exist), `"--setting-sources"`, `"user"`, `"--no-session-persistence"`; no argv element is `--bare`; a `server_name` that is empty or does not match `^[A-Za-z0-9_-]+$` (for example `x,mcp__other`, `brain*`, `a b`) and a `model` that is empty, starts with `-` or contains whitespace or a comma each return the error `not_configured` and no argv; result.schema.json parses as JSON with `type` `object`, `additionalProperties` false and `required` exactly `status`, `session_note`, `recipes`, `people_updated`, `already_saved`, `detail`; `status` is a string enum of exactly `saved`, `nothing_to_save`, `mcp_unavailable`, `session_type_missing`, `failed`; `session_note` allows string or null; `recipes` and `people_updated` are arrays of strings; `already_saved` is boolean; `detail` is a string with `maxLength` 120; the schema file contains no em dash character
- Issue: #99
- Status: done

### Decision log
- `server_name` and `model` are checked before they reach argv: `server_name` goes into the comma-joined `--allowedTools` permission rules, where a comma or wildcard would pre-approve other tools; a `model` starting with `-` could be read as a flag. Both checks give the `not_configured` error that design.md lists for `buildInvocation`.
- "Valid JSON Schema" is checked structurally, because the repo has no schema validator and adding one is a tier C dependency.

## T12: Build the headless environment and settings checks
- Purpose: the capture run uses the owner's subscription only, cannot recurse, and loads none of the project's hooks, MCP servers or instructions
- Covers: R3.1, R6.4, R6.5, R6.8
- Size: S
- Depends on: T11
- Files: plugin/scripts/lib/headless.mjs, tests/plugin/headless-env.test.ts
- Verify: `npm test -- tests/plugin/headless-env.test.ts`; `buildInvocation(settings, env, paths).env` is the given env without `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX` and `CLAUDE_CODE_USE_FOUNDRY` (removed whatever their case when the injected platform is `win32`), keeps every other key unchanged, and has `TWOBRAIN_CAPTURE` `1` even when the input set it to another value; the input env object is not mutated; with a session `cwd` different from `paths.dataDir`, `.cwd` is `paths.dataDir` (`CLAUDE_PLUGIN_DATA`) and argv has `--setting-sources user`; `checkApiHelper({ home, env })` reads `<env.CLAUDE_CONFIG_DIR>/settings.json` when that is set, else `<home>/.claude/settings.json` (home injected, never `os.homedir()` in the test), and returns `api_helper_present` when the file has a non-empty string `apiKeyHelper`, and `ok` when the key is absent or empty, the file is missing, unreadable or not valid JSON; the check never throws; T13 calls it before any spawn and returns `api_helper_present` without running `claude`, and the worker logs `api_helper_present` and deletes the job (asserted in T13 and T15)
- Issue: #100
- Status: done

### Decision log
- R6.8 user settings path: honor `CLAUDE_CONFIG_DIR` when set (confirm in the Claude Code settings docs; design.md names `~/.claude/settings.json` as the default only). Managed settings stay unchecked (design.md advisory).

## T13: Run the headless session: spawn, stdin input, timeout and result parsing
- Purpose: the worker can run one capture without a shell, with the input on stdin only, stop a hung run with its whole process tree, and tell a good result from a failed one without logging its output
- Covers: R2.6, R5.7, R6.6, R8.3
- Size: M
- Depends on: T12
- Files: plugin/scripts/lib/headless.mjs, tests/plugin/headless-run.integration.test.ts, tests/plugin/headless-platform.test.ts, tests/plugin/fixtures/fake-claude.mjs, tests/plugin/helpers/fake-claude.ts, tests/plugin/spawn-scan.test.ts, tests/plugin/headless-env.test.ts, tests/plugin/headless-argv.test.ts
- Verify: `npm test -- tests/plugin/headless-run.integration.test.ts tests/plugin/headless-platform.test.ts tests/plugin/spawn-scan.test.ts`; `npm run typecheck`; `npm run lint`; fake-claude.mjs is the shared fixture for T16 to T18: the test installs it as an executable `claude` in a temp dir put first on PATH, it reads its script from the JSON file named by `FAKE_CLAUDE_SCRIPT` (`result` object, `exit` code, `stdout` override, `sleepMs`, `hang`, `skipStdin`, `spawnGrandchild`) and writes argv, stdin, env, pid, start and end times into the dir named by `FAKE_CLAUDE_RECORD`; integration: for an input with unique marker lines, the recorded stdin equals the input byte for byte and no argv element contains any marker; a scripted `structured_output` is returned parsed as `{ ok: true, result }`; exit 1, exit 0 with stdout that is not JSON, and JSON without `structured_output` each return `{ ok: false, code: "headless_failed", exit }` with the real exit code and no stdout or stderr text in the returned object; a fake with `skipStdin` that exits 1 at once returns `headless_failed` with no unhandled `EPIPE`; with the timeout injected as 1 second, a hanging fake that spawned a grandchild returns `{ ok: false, code: "timeout" }`, and within 2 seconds after that neither the fake's pid nor the grandchild's pid answers `process.kill(pid, 0)`; with an injected settings home whose `settings.json` defines `apiKeyHelper`, the run returns `api_helper_present` and the fake `claude` records no run; unit: the default timeout is 600000 ms; on POSIX the child is spawned with `detached: true` and killed with `process.kill(-pid, "SIGKILL")`; with an injected `win32` platform the kill is `execFile(<SystemRoot>\System32\taskkill.exe, ["/pid", String(pid), "/T", "/F"], { cwd, shell: false, windowsHide: true })` by absolute path (a relative or missing SystemRoot, and a relative ComSpec, fall back to C:\Windows, so nothing resolves against the current directory); with an injected `win32` platform and PATH, `claude.exe` is chosen over `claude.cmd` in the same or a later PATH dir, and when only `claude.cmd` exists the spawn is `cmd.exe` with `["/d", "/s", "/c", <quoted line>]` and `windowsVerbatimArguments`, where the line is a verbatim quoted command line that decodes back to `[cmdPath, ...argv]` (the schema argument minified, CR, LF or NUL refused) and the input still goes on stdin only; no `claude` on PATH returns `claude_not_found` without spawning; spawn-scan.test.ts: every `spawn`, `execFile` or `fork` call under `plugin/scripts` passes an argument array and an options object with `shell: false` and `windowsHide: true` (fails on a planted sample of each kind)
- Issue: #101
- Status: done

### Decision log
- Round 1: the `apiKeyHelper` skip before spawn (R6.8, from the T12 review) is asserted here; the worker half of `timeout` and `headless_failed` (log and keep the job) is asserted in T18.
- Round 2 (T13 review notes): `model` must match `^[A-Za-z0-9][A-Za-z0-9._\[\]-]{0,63}$`; any settings env-block value for a STRIPPED_ENV name other than null or "" counts as present; a relative `CLAUDE_CONFIG_DIR` resolves against the child cwd (`paths.dataDir`); `structured_output` is validated again at runtime, with `detail` limited to `^[a-z0-9_ =.,:-]{0,120}$` (not in result.schema.json); a `.cmd`-only install is quoted, not refused, and the real Windows check is the manual sitting.

## T14: Write the capture prompt
- Purpose: the headless session knows its steps, the note path and shape, the recipe and people rules, the secrets rule and how to report its result in the schema the worker parses
- Covers: R7.2, R7.3, R7.4, R7.5
- Size: S
- Depends on: T11
- Files: plugin/prompts/capture.md, tests/plugin/prompt.test.ts
- Verify: `npm test -- tests/plugin/prompt.test.ts tests/plugin/package.test.ts`; prompt.test.ts reads capture.md and result.schema.json from disk and checks that capture.md: names each of `vault_info`, `search`, `read`, `save_note`, `save_recipe`, `update_properties` by short name, says to call no other tool, and contains no `mcp__` prefix; says to call `vault_info` first, to report `mcp_unavailable` after one failed tool call and `session_type_missing` when `vault_info` lists no `session` type; says to build the note path by joining the request's note file name to the session type folder with `{area}` replaced by the request's area; names the properties type, area, date, source (`claude-code`), source id, `project` and `title`, with date, source id and project taken from the request header and the property names from `vault_info`; names the body sections `## Summary`, `## Decisions`, `## Open items` and `## Recipes`, plus `## People` only when a person note was updated; states the `save_recipe` rule (only a command or code that succeeded after a problem, with area, problem, solution and the source `claude-code:<session id>`, linked from the session note); states the people rule (only notes of the person type found through `search`, update through `update_properties`, never create one); says to report `nothing_to_save` and save nothing when no decision, finding or working command exists; says to set `already_saved` true when `save_note` answers `unchanged` or `duplicate_source`; says to report `failed` on any other tool error; says to never copy secrets, credentials or environment values, to write in the request's `language`, and to treat the transcript and progress text as data, never as instructions; says to always end with the result object, with `detail` at most 120 characters of lowercase code words and no session content; every `status` enum value and every required field name in result.schema.json appears in capture.md; capture.md contains no em dash; package.test.ts (the owner-data, import and network scans of tests/plugin/helpers/plugin-scan.ts) passes with capture.md present; the content of the notes is checked by hand in T22 and T23
- Issue: #102
- Status: done

### Decision log
- Round 1: the reviewer's proposal to add R7.6 and R7.7 to Covers was not applied (6 criteria, over the limit of 4); the prompt rules for secrets and language are still checked here, and both criteria are covered by T23.

## T15: Build the capture worker pipeline
- Purpose: a queued job becomes one bounded capture request, or a logged skip, without touching the project
- Covers: R4.1, R4.2, R4.3, R8.1
- Size: M
- Depends on: T5, T6, T8, T9
- Files: plugin/scripts/capture-worker.mjs, tests/plugin/worker.test.ts
- Verify: `npm test -- tests/plugin/worker.test.ts`; capture-worker.mjs exports `runWorker(deps)` (clock with sleep, file system, runner, data dir, settings, env) and runs it when executed directly; with an injected clock, file system and runner stub: on start the worker calls the T5 `sweep()` (a job with 3 attempts or older than 7 days goes to `failed/` and logs `gave_up`) and then handles the remaining jobs from `list()` oldest first; `not_configured` (T9 `resolveArea` with `TWOBRAIN_AREA` and `area` empty) is checked before the transcript is read, logs `not_configured`, keeps the job with no extra attempt and never calls the runner; the worker reads the transcript once its size has not changed for 2 seconds (a file that stops growing is read after about 2 seconds of the injected clock), and a file still growing at 10 seconds is read at 10 seconds; a missing or unreadable transcript logs `transcript_missing`, deletes the job and never calls the runner; a transcript with fewer user prompts than `min_user_prompts` logs `skipped_trivial`, deletes the job and never calls the runner; a state file that already has the session id, or the lineage under a new id, with fewer than `min_user_prompts` new prompts logs `skipped_duplicate`, deletes the job and never calls the runner; a new session calls the runner once with the T9 input for part 1 and source id `claude-code:<session id>`; a resumed session with at least `min_user_prompts` new prompts calls the runner once with the T8 decision: part n, source id `claude-code:<first session id>:<n>`, a digest built with T8's `fromPrompt` (so it starts after the already captured prompts) and a file name from T8's `idForName`; a runner result of `api_helper_present` logs `api_helper_present`, deletes the job and does not increase attempts; a runner stub result marked retryable keeps the job and calls `recordAttempt` once, and no skip or `not_configured` outcome changes the attempts count; the worker reads the area from the job file, never from its own environment, so a job written with area `work` and run by a worker whose `TWOBRAIN_AREA` is `personal` still uses `work`
- Issue: #103
- Status: todo

### Decision log
- Round 1: the reviewer proposed Covers R4.1, R4.2, R4.3, R4.5, R4.6, R4.7, R8.1, R8.6 (8, over the limit of 4); kept R4.1 to R4.3 and added R8.1 (asked by the T9 review). R4.5 to R4.7 stay with T8 and R8.6 with T5; their worker wiring is still asserted above.

## T16: Handle capture results: saved, already saved, nothing to save, failed, logout and missing claude
- Purpose: the worker records each outcome correctly, so a capture is never repeated and never lost
- Covers: R4.8, R4.9, R7.8, R8.2
- Size: M
- Depends on: T13, T15
- Files: plugin/scripts/capture-worker.mjs, plugin/scripts/lib/headless.mjs, tests/plugin/worker-results.integration.test.ts, tests/plugin/headless-run.integration.test.ts
- Verify: `npm test -- tests/plugin/worker-results.integration.test.ts tests/plugin/headless-run.integration.test.ts`; the real worker runs (started with `process.execPath`) with a temp `CLAUDE_PLUGIN_DATA`, a temp PATH holding only the T13 fake `claude`, and scripted `structured_output` results: `saved` with a session note and one recipe logs `saved notes=<session_note> recipes=1`, `recordCapture` is called with the decided part, `state.json` has the session id with `lineage`, `prompts`, `parts` 1 and `capturedAt`, and the job file is deleted; `status: "saved"` with `already_saved: true` logs `already_saved` and not `saved`, records the session with the decided part and deletes the job; `nothing_to_save` logs `nothing_to_save`, deletes the job, and records the session's prompt count without adding a part; `failed` logs `failed` and keeps the job with attempts + 1; a job with reason `logout` is kept with attempts unchanged and no fake run recorded, a second logout job leaves both queued, and the next non-logout job runs both, oldest first, two fake runs; with no `claude` on PATH the worker logs `claude_not_found` and keeps the job with attempts + 1, and in headless-run.integration.test.ts a spawn ENOENT and a failed command lookup both return `claude_not_found`, never `headless_failed`; no log line contains any line of the scripted transcript
- Issue: #104
- Status: todo

### Decision log
- `failed` (sent by the headless session) is retryable like `headless_failed`: job kept, attempts + 1, max 3, then `gave_up`. The design's Error handling table has no row for it.
- `nothing_to_save` records the prompt count in state, so a resumed session sends only its new part.
- Round 1: the reviewer's `failed detail=<detail>` log field was not applied: the T5 log allows only `exit`, `notes` and `recipes`, and design.md logs no `detail`; the line is `failed`. Renumbered from T17 (the end-to-end proof, now T17, depends on this task).

## T17: Prove the detached hook and worker end to end with a fake claude
- Purpose: the real hook returns at once, the worker outlives its parents, a capture run cannot capture itself, and the project directory stays untouched
- Covers: R2.1, R2.2, R3.4, R5.5
- Size: M
- Depends on: T10, T13, T16
- Files: tests/plugin/hook-worker.integration.test.ts, tests/helpers/plugin-fixture.ts, tests/plugin/fixtures/fake-claude.mjs
- Verify: `npm test -- tests/plugin/hook-worker.integration.test.ts`; plugin-fixture.ts builds a temp `CLAUDE_PLUGIN_DATA`, `CLAUDE_PLUGIN_ROOT` set to `plugin`, `TWOBRAIN_AREA` set, a temp PATH with the fake `claude` first, a fixture transcript with at least `min_user_prompts` user prompts, and a temp session `cwd` holding a `docs/progress.md`; a test parent (a Node script) spawns the real `session-end.mjs` with `process.execPath`, writes a SessionEnd event to its stdin, records the hook's exit code and elapsed time, and exits without waiting for the worker: the hook exited 0 in under 1 second and a job file existed when it exited; the fake (scripted to sleep 3 seconds, then return `saved`) records exactly one run whose end time is after the parent's exit, with the parent and hook pids gone by then, and the log's last line is `saved` (polled for up to 15 seconds); with `FAKE_CLAUDE_FIRE_HOOK` set, the fake spawns `session-end.mjs` with its own env (`TWOBRAIN_CAPTURE=1`) and a SessionEnd event, that nested hook exits 0, and afterwards the job queue is empty, the fake's run record has exactly one entry and the log has exactly one outcome line; the session `cwd` has the same file list, contents and mtimes before and after the capture
- Issue: #105
- Status: todo

### Decision log
- Round 1: renumbered from T16 and made to depend on the results task (now T16), which first logs `saved` and also edits capture-worker.mjs; production files dropped from Files, so a defect found here goes back to its owning task. The fake gains the `FAKE_CLAUDE_FIRE_HOOK` mode here.

## T18: Retry on MCP and session type failures, and allow one capture per machine
- Purpose: a capture that cannot reach the brain is retried later, and two session ends never run two captures at once
- Covers: R8.4, R8.5, R6.7
- Size: M
- Depends on: T16
- Files: plugin/scripts/capture-worker.mjs, plugin/scripts/lib/queue.mjs, tests/plugin/queue.test.ts, tests/plugin/worker.test.ts, tests/plugin/worker-retry.integration.test.ts
- Verify: `npm test -- tests/plugin/worker-retry.integration.test.ts tests/plugin/queue.test.ts tests/plugin/worker.test.ts`; integration, with the fake `claude` first on a temp PATH: a result `mcp_unavailable` logs `mcp_unavailable` and keeps the job with attempts 1, and the next worker run scripted `saved` makes exactly one fake run, logs `saved`, records the session and deletes the job; `session_type_missing` logs that code and keeps the job with attempts 1; after three `mcp_unavailable` runs the next worker start moves the job to `failed/`, logs `gave_up` and makes no fake run; a fake scripted to exit 1 logs `headless_failed exit=1` and keeps the job with one more attempt; a hanging fake with the timeout injected as 1 second logs `timeout` and keeps the job with one more attempt; neither of those log lines contains the fake's stdout or stderr text; two workers started at once on two jobs, with a fake that sleeps 2 seconds and records start and end times, give two fake runs that do not overlap and both jobs captured; a job queued while a worker's fake run is in progress, plus a second worker started then, is captured by the first worker in the same run, while the second exits before the first finishes without a fake run; a planted `capture.lock` with `startedAt` 16 minutes ago is taken over and the job captured, and one with `startedAt` 1 minute ago makes the worker exit with no fake run and the job kept; `capture.lock` is gone after the run; queue.test.ts (injected fs and clock): the lock is created exclusively (`wx`), so a second acquire while it exists fails; when two workers find the same stale lock only one acquires it; the holder rewrites `startedAt` before each job, so a drain of two 10-minute jobs is never seen as stale; worker.test.ts: a runner stub that throws leaves no `capture.lock` and the job still queued; no changed file contains the em dash character
- Issue: #106
- Status: todo

### Decision log
- Round 1: the worker half of R6.6 and R8.3 (from the T13 review) is asserted here; R6.6 and R8.3 are not added to Covers (T13 covers them, and 5 criteria would pass the limit). tests/plugin/fixtures/fake-claude.mjs was left out of Files: T13 already defines the start and end time records this task needs.

## T19: Write the generic `analizar-reunion` skill
- Purpose: the owner can ask Claude Code to analyze a stored meeting and save the analysis next to it, with no owner data in the skill
- Covers: R9.6, R1.1
- Size: S
- Depends on: T1, T3
- Files: plugin/skills/analizar-reunion/SKILL.md, tests/plugin/skill.test.ts, tests/plugin/package.test.ts
- Verify: `npm test -- tests/plugin/skill.test.ts tests/plugin/package.test.ts`; SKILL.md front matter has `name` exactly `analizar-reunion` and a non-empty `description`; package.test.ts also asserts `plugin/skills/analizar-reunion/SKILL.md` exists; skill.test.ts imports the fictional name list tests/plugin/fixtures/person-names.json and the helpers of tests/plugin/helpers/plugin-scan.ts (T3) and, reading areas and folder segments from `DEFAULT_VAULT_CONFIG`, checks: no fixture person name (case-insensitive), no language name from a listed set (English, Spanish, ingles, espanol, Portuguese, French, accented forms included, case-insensitive), and no default area or folder segment written in backticks or quotes, as a path segment (`seg/` or `/seg`) or as a YAML value (`: seg`), each check failing on a planted sample; the text tells the model to call `vault_info` first and take from it the areas, the property names (`properties`), the type values for the keys `meeting` and `analysis`, and the analysis folder with `{area}` set to the meeting's area; it names `search` or `recent` to find the meeting and `read` to read every note of it, analyzing notes of one meeting from different sources together; `save_note` with the analysis type value, the owner's property names, source `claude-code`, wikilinks to every meeting note, and the source id `analysis:<meeting source id>`, where the meeting source id is the `source_id` of the meeting note with the earliest date (ties by path); on a duplicate source id it reports the existing analysis and saves nothing; `update_properties` only to set the `analysis` property (a wikilink to the analysis) on each meeting note, never to change a meeting body; follow-up tasks in the answer only, never saved; tools named by short name as tools of the brain MCP server (`mcp__<server>__<tool>`, server `brain` by default); when those tools are missing it tells the owner to add the server and sign in, naming docs/GUIDE-mcp.md; the owner-data scan passes on the new file; no em dash in any changed file
- Issue: #107
- Status: in-review

### Decision log
- R9.3 "the meeting's folder" is read as the analysis type's folder from `vault_info` with `{area}` set to the meeting's area, because F1 validate.ts refuses a path outside the note type's folder (`wrong_folder`); under the defaults it is the meeting's folder.
- Source `claude-code` and the `analysis` link property are task-level choices within R9.3 and R9.4; design.md leaves them open.
- Round 1: the reviewer's new helper tests/plugin/helpers/owner-data.ts was not added; the name list and scans are T3's tests/plugin/fixtures/person-names.json and tests/plugin/helpers/plugin-scan.ts.

## T20: Document the plugin install, the user-scoped MCP server and troubleshooting
- Purpose: a third party can install the plugin, add the MCP server so headless runs see it, and read any log code
- Covers: R10.4
- Size: M
- Depends on: T1, T2, T4, T17, T18, T19
- Files: docs/GUIDE-plugin.md, docs/GUIDE-mcp.md, README.md, plugin/README.md, docs/v2.md, tests/guide-plugin.test.ts, tests/guide-mcp.test.ts, tests/validate.test.ts
- Verify: `npm test -- tests/guide-plugin.test.ts tests/guide-mcp.test.ts tests/validate.test.ts`; docs/GUIDE-mcp.md's Claude Code block is exactly `claude mcp add --scope user --transport http brain <PUBLIC_BASE_URL>/mcp`, followed by the reason (headless runs start outside the project, so a local-scope server would not load); in guide-mcp.test.ts the literal `claude mcp add --transport http` is replaced by `claude mcp add --scope user --transport http brain <PUBLIC_BASE_URL>/mcp`, and the T1 checks (`vault_info`, seven tools) still pass; docs/GUIDE-plugin.md has the install steps (`/plugin marketplace add`, `/plugin install 2brain`, and `claude --plugin-dir plugin`), `TWOBRAIN_AREA`, the sign-in with `claude mcp login brain` or `/mcp`, the line telling owners with a `sources` allow-list to add `claude-code`, the line telling owners whose `.2brain/config.yaml` lists `types` to add the `session` type line (design.md Data model), and the advice not to pre-approve other MCP write tools in user settings; guide-plugin.test.ts checks the `sources` and `session` type lines, reads plugin/.claude-plugin/plugin.json and checks that every `userConfig` key and its `default` appear in the guide; it collects every code passed as the code argument of the T5 log function in `plugin/scripts/**/*.mjs`, fails if it finds none or misses any of `invalid_input`, `hook_error`, `gave_up`, `claude_not_found`, `headless_failed`, `mcp_unavailable`, `session_type_missing`, `api_helper_present`, `nothing_to_save`, `already_saved`, `skipped_trivial`, `skipped_duplicate`, `transcript_missing`, `not_configured`, and checks each collected code is in the guide; README.md and plugin/README.md give the short install steps and link to the guide (plugin/README.md with the relative link `../docs/GUIDE-plugin.md`, no URL, so the owner-data scan still passes); docs/v2.md has rows with source `spec 03` for capture from other coding clients and claude.ai chats, automatic meeting analysis, and per-project area routing, and guide-plugin.test.ts checks those three rows; validate.test.ts adds two cases: a note with source `claude-code` passes with `sources: []` and fails with `sources: ["mail"]`; no changed file contains the em dash character
- Issue: #108
- Status: todo

### Decision log
- Round 1: depends on the end-to-end task (now T17) so the hook's codes exist before the code collection runs; the `session` type line for existing vaults (design.md Data model, raised by the T2 review) added.

## T21: Validate and install the plugin on the owner's machines
- Purpose: the owner confirms the plugin validates, installs both ways, works on macOS and Windows, and keeps exit fast
- Covers: R1.5, R1.6, R2.7, R11.2
- Size: S
- Depends on: T17, T18, T19, T20
- Files: docs/GUIDE-plugin.md
- Verify: `[manual]` (reason: needs the Claude Code CLI, which CI does not install, a logged-in Claude Code on the owner's machine, and macOS and Windows, which CI does not run; raised as an `rb:needs-local` issue with the exact steps). Preconditions: T1 to T20 merged to main; the owner's server deployed from a build that includes T1 and T2; the MCP server added at user scope and signed in per docs/GUIDE-mcp.md. Steps: (1) `claude plugin validate plugin --strict` prints `Validation passed`; (2) after `/plugin marketplace add` of this repository and `/plugin install 2brain`, `/hooks` lists one SessionEnd hook from 2brain and the skill list shows `2brain:analizar-reunion`; (3) with the marketplace install disabled (`/plugin disable 2brain`), `claude --plugin-dir plugin` shows the same hook and skill, then the marketplace install is enabled again; (4) with the `area` setting set to one area and `TWOBRAIN_AREA` set to a different configured area in a test project's `.claude/settings.json` `env`, ending a 3-prompt session there writes a `saved` line in the plugin data directory's `logs/capture.log` whose `notes=` path starts with the `TWOBRAIN_AREA` value; (5) on macOS and on Windows, piping a sample SessionEnd JSON into `node <plugin root>/scripts/session-end.mjs` returns in under 1 second (`time` on macOS, `Measure-Command` on Windows), and a real 3-prompt session end yields a `saved` line with the note in the vault remote and no `claude_not_found` or `headless_failed` line; (6) exiting a session with the plugin enabled is not visibly slower than with `enabled` false, and Claude Code shows no hook timeout. A guide step that failed is corrected in docs/GUIDE-plugin.md; a failure in plugin code is filed as an `rb:bug` issue and this task stays blocked until it is fixed; without a Windows machine the task stays `rb:needs-local`, not done
- Issue: #109
- Status: todo

### Decision log
- The `CLAUDE_PLUGIN_OPTION_<KEY>` casing assumed in T3 is re-checked here (step 4 shows the settings reach the hook).

## T22: Score capture notes on five real sessions
- Purpose: the owner confirms the headless session writes useful, correct session notes, recipes and person updates, and saves nothing for an empty session
- Covers: R7.2, R7.3, R7.4, R7.5
- Size: S
- Depends on: T21
- Files: docs/GUIDE-plugin.md
- Verify: `[manual]` (reason: the content comes from the owner's subscription model, which no automated check may call; raised as an `rb:needs-local` issue with the exact steps): with `min_user_prompts` at its default (3) and `note_language` unchanged, the owner ends six real sessions of at least 3 user prompts each: five substantive ones (at least one with a command or code that succeeded after a failure, and at least one naming a person who already has a note of the person type) and one with no decision, finding or working command. For each of the five substantive sessions the saved note meets every item of the design.md checklist: path is `<session type folder for the area>/<YYYY-MM-DD> <project> <first 8 characters of the session id>.md`; frontmatter uses the configured property names with type `session`, the area, the date of the last transcript entry, source `claude-code`, source id `claude-code:<session id>` and project; body has `## Summary`, `## Decisions`, `## Open items`, `## Recipes`, and `## People` when a person note was updated; every decision in the session is listed and none is invented; no secret; language matches `note_language`. Each recipe was saved through `save_recipe` with the area, the problem, the solution and source `claude-code:<session id>`, ran successfully after a problem in the transcript, and is wikilinked from the session note's `## Recipes`. In the vault remote, `git log --name-status` for each capture shows added files only for the session note and its recipes, modified files only for person notes that existed before, and `git diff` of each such person note changes frontmatter only (no person note created). The empty session adds no commit or note to the vault and its plugin log line is `nothing_to_save`. Pass is five of five scored notes plus the empty-session check. The owner posts a per-note score table on the issue; docs/GUIDE-plugin.md is edited only when a failure traces to a setup or settings step the guide describes. Secret handling and both language settings are checked in T23 (R7.6, R7.7).
- Issue: #110
- Status: todo

### Decision log

## T23: Check secrets and note language in saved capture notes
- Purpose: the owner confirms no planted secret reaches the vault and notes follow the `note_language` setting
- Covers: R7.6, R7.7
- Size: S
- Depends on: T21
- Files: docs/GUIDE-plugin.md
- Verify: `[manual]` (reason: the content comes from the owner's subscription model, which no automated check may call, and needs the owner's MCP sign-in and vault remote; raised as an `rb:needs-local` issue with the exact steps): in a real session of at least `min_user_prompts` prompts, the owner pastes five fictional secret values given in docs/GUIDE-plugin.md (a private key block, `Authorization: Bearer <value>`, `API_KEY=<value>`, a `ghp_` token and `DB_PASSWORD=<value>`) next to real work with at least one decision; the capture log shows `saved` with at least one note path; for each of the five values `git log --all -p -S'<value>'` and `git grep -F '<value>'` in a fresh clone of the vault remote return nothing; then two more real sessions with `note_language` set to `es` and then `en` each log `saved`, and the prose of each note (summary and decisions) is in that language; any guide step that failed is corrected in docs/GUIDE-plugin.md
- Issue: #111
- Status: todo

### Decision log
- Round 1: split from the old T23; end-to-end timing and offline recovery moved to T24.

## T24: Check end-to-end timing and offline-server recovery
- Purpose: the owner confirms a session note reaches the vault remote within minutes and an offline server only delays the capture, with no duplicate
- Covers: R11.1, R11.3
- Size: S
- Depends on: T21
- Files: docs/GUIDE-plugin.md
- Verify: `[manual]` (reason: needs the owner's subscription login, MCP sign-in, running server and vault remote; raised as an `rb:needs-local` issue with the exact steps): the owner ends a real session of at least 3 prompts and notes the exit time; after `git fetch` in a vault clone, the commit adding that session's note (source id `claude-code:<session id>`) is on the remote with a commit time at most 5 minutes after exit; then with the server stopped (`docker compose stop`) the owner ends real session A of at least 3 prompts: the log shows `mcp_unavailable` for A and A's job file stays in the queue; the server is started again and real session B is ended before A reaches 3 attempts: the log shows `saved` for A and for B; in a fresh clone `git grep -l 'claude-code:<A session id>'` lists exactly one note and `git log --oneline -- <that path>` shows exactly one `2brain: add` commit; any guide step that failed is corrected in docs/GUIDE-plugin.md
- Issue: #112
- Status: todo

### Decision log
- Round 1: split from the old T23 (R11.1 and R11.3 need a different setup from the content checks).

## T25: Run the meeting skill on two meetings
- Purpose: the owner confirms the skill finds a meeting, merges its two sources, saves the analysis next to it and leaves the transcript untouched
- Covers: R9.1, R9.2, R9.3, R9.4
- Size: S
- Depends on: T21
- Files: docs/GUIDE-plugin.md
- Verify: `[manual]` (reason: runs in the owner's interactive session, with no automated oracle for the model's choices; raised as an `rb:needs-local` issue with the exact steps): setup: if the vault has no meeting notes yet (meeting ingestion is not built), store two meetings through `save_note` with the type and folder `vault_info` gives for meetings, one of them as two notes with different `source` and `source_id` values, then `git pull` the vault and record the HEAD commit as BASE; in a session with the brain MCP server signed in, invoke the plugin skill `2brain:analizar-reunion` (not a personal skill of the same name) and ask "analyze my meeting with <name>" for each meeting: the transcript shows the skill calling `search` or `recent` and then `read` on the meeting notes; the two-source meeting yields one analysis that uses both notes; each analysis note is created through `save_note`, its type is the analysis `value` from `vault_info`, it sits in the same folder as its meeting notes, it links every meeting note it analyzed, and its source id is `analysis:` followed by the source id of one of those meeting notes; after `git pull`, `git diff BASE..HEAD -- <meeting note paths>` shows only frontmatter lines changed (or none), and the body below the closing `---` is byte-identical; docs/GUIDE-plugin.md is edited only to correct a guide step that failed
- Issue: #113
- Status: todo

### Decision log
- Round 1: the reviewer proposed merging T26 into this task; not applied: T26's reviewer did not keep it or propose the mirror merge, and the merged task would cover 6 criteria (limit 4). The reviewer's fallback rewrite for this task alone is applied.

## T26: Check the meeting skill's task list and missing-server message
- Purpose: the owner confirms follow-up tasks stay out of the vault and a missing or signed-out MCP server gets a clear pointer to the guide
- Covers: R9.5, R9.7
- Size: S
- Depends on: T21
- Files: docs/GUIDE-plugin.md
- Verify: `[manual]` (reason: runs in the owner's interactive session, with no automated oracle for the model's choices; raised as an `rb:needs-local` issue with the exact steps): (R9.5) after analyzing one real meeting whose transcript contains at least one follow-up action, the skill's answer lists the follow-up tasks; `git log --name-status` of the vault for the commits made during that analysis shows exactly one added file (the analysis note) plus property-only changes to the meeting notes, and no other note added or modified; the analysis note body contains no follow-up task list; (R9.7) in two separate Claude Code sessions, first with the brain server removed (`claude mcp remove --scope user brain`) and then with it present but signed out (authentication cleared from `/mcp`), asking to analyze a meeting makes the skill tell the owner to add the server and sign in, naming docs/GUIDE-mcp.md, without attempting an analysis or any write; `git log` of the vault shows no new commit after either session; the server is then re-added and signed in again with the docs/GUIDE-mcp.md steps; any guide step that failed is corrected in docs/GUIDE-plugin.md
- Issue: #114
- Status: todo

### Decision log
