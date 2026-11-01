# Tasks: Meetings without LLM
Spec: docs/specs/05-meetings/  |  Status: approved  |  Converged: 2026-11-01, 1 round (single combined reviewer pass)

<!--
Field names and statuses stay in canonical English (parsed strictly by `rb tasks`; unknown keys
or statuses are errors). Statuses: todo, in-progress, in-review, done, blocked.
Builds on F1 to F4 (merged): no skeleton task. Nothing of this feature exists yet: no
src/meetings/, no src/sources/, no src/vault/write-meeting.ts, no n8n/ folder, no
tests/fixtures/meetings/, no docs/GUIDE-meetings.md. Existing pieces reused, not rebuilt: the
token middleware and readJsonBody (src/server/app.ts), the error table (src/server/errors.ts),
the write queue, sync, scrub, validation and push retries (src/vault/write-note.ts,
src/git/sync.ts), the source index (src/vault/source-index.ts), `commitPaths`
(src/git/index.ts), the bare-remote helper (tests/helpers/git-fixture.ts) and the mock LLM
provider (src/llm/mock.ts).
Sizing (owner guidance, ragarciaga/rockbuilt#41): fewer, larger tasks, each one verifiable
outcome, adjacent pieces of one module merged. The hard limit of 4 Covers per task sets the
floor: 68 automated criteria need at least 17 tasks; this backlog uses 18, plus 2 manual.
Order: config section, pure modules (schema and mappers, normalizer, calendar and area, path,
frontmatter, version matcher), the route, the meeting writer in four slices, the n8n templates,
the guide, and last the manual checks.
Tier C tasks named by design.md Risk and cost stay alone: T1 (vault config schema, ADR 0020),
T8 (new ingest route and error code, ADR 0019), T14 to T17 (n8n/templates/**, a Sensitive path;
Fireflies and Google Meet API access). No task adds a dependency, an environment variable or an
LLM call. No file matches src/sources/**/delete*.ts.
Manual criteria are grouped by what the owner runs in one sitting (T19, T20), each an
`rb:needs-local` issue.
-->

## T1: Add the optional meetings section to the vault config with its cross checks
- Purpose: an owner sets time zone, minimum length, labels, area rules, source values and meeting property names in `.2brain/config.yaml`, a vault without the section keeps working on the defaults, and a bad meeting setup blocks only meeting requests
- Covers: R10.1, R10.2, R10.3
- Size: M
- Depends on: none
- Files: src/config/vault-config.ts, src/config/defaults.ts, vault-template/.2brain/config.yaml, tests/vault-config.test.ts, tests/template.test.ts, tests/meetings-config.test.ts
- Verify: `npm test -- tests/vault-config.test.ts tests/template.test.ts tests/meetings-config.test.ts`; `npm run typecheck`; `npm run lint`; `VaultConfig` gains `meetings` with exactly the keys and defaults of design.md "Data model" (timezone UTC, min_minutes 5, untitled_label `Untitled meeting`, unknown_speaker_label `Speaker`, default_area null, area_rules [], sources fireflies and gemini with value and label, the eight properties); DEFAULT_VAULT_CONFIG and vault-template/.2brain/config.yaml spell out the same section and the existing case "loads to exactly the default config" passes; a config file without `meetings` loads to the defaults (case "no meetings section uses defaults"); `loadVaultConfig` throws `ConfigInvalidError` naming `.2brain/config.yaml` and the key path for each of: unknown key under `meetings`, a rule area or `default_area` not in `areas`, a rule with both or neither of `domain` and `calendar`, timezone `Mars/Base` (rejected through `Intl.DateTimeFormat`), `min_minutes` -1 and 121, two meeting properties with the same name, a meeting property equal to a canonical owner name or to `analysis`; exported `requireMeetingSetup(config)` throws `ConfigInvalidError` with key path `types.meeting` when the meeting type is missing or has no folder, and `sources` when the allow-list is non-empty and lacks a meeting source value, while `loadVaultConfig` of the same file succeeds (case "meeting checks do not block other writes"); `version` stays 1
- Issue: #196
- Status: done

### Decision log

## T2: Parse both meeting payloads and map them to one MeetingInput
- Purpose: the service accepts the Fireflies and Google Meet API shapes as n8n fetched them, refuses anything malformed or unfinished, and turns either into the same internal input with speaker labels exactly as delivered
- Covers: R1.3, R2.2, R2.8
- Size: M
- Depends on: none
- Files: src/meetings/types.ts, src/meetings/schema.ts, src/sources/fireflies/map.ts, src/sources/gemini/map.ts, tests/meetings-schema.test.ts, tests/meetings-map.test.ts
- Verify: `npm test -- tests/meetings-schema.test.ts tests/meetings-map.test.ts`; `npm run typecheck`; `npm run lint`; src/meetings/types.ts exports `CalendarEvent`, `FirefliesBody`, `GeminiBody`, `MeetingInput` and `MeetingOk` as in design.md "Interfaces and contracts"; `parseMeetingBody` ignores unknown fields and rejects with Zod issues (paths and messages only) each of: missing `transcript.id`, wrong type of `transcript.date`, `source: "zoom"`, end not after start, a recording longer than 12 hours, 50,001 segments, 501 participants, 51 calendar events; case "issues carry no value": a planted marker string in every rejected field is absent from `JSON.stringify(issues)`; a Gemini body whose `transcript.state` is not the finished state yields a `TranscriptNotReadyError` (exported) and no MeetingInput; `sourceUrl` is set only when the URL parses with protocol `https:` (`http:`, `javascript:` and a relative URL give undefined); `mapFireflies` turns epoch ms `date` and float minutes `duration` into `start` and `end`, `sentences` into segments with `offsetSeconds` from `start_time`, `meeting_attendees` and `participants` into `people`, `organizer_email` into `organizerEmail`; `mapGemini` takes each entry's speaker from the display name of its participant (signed-in, anonymous or phone user) and uses the configured unknown speaker label for an entry whose participant is missing from the list (case "unknown participant"); case "labels as delivered": `Speaker 1` and ` Ana Ruiz ` arrive as `Speaker 1` and `Ana Ruiz` (NFC, trimmed, nothing else changed); no file under src/meetings or src/sources imports src/llm or @anthropic-ai/sdk
- Issue: #197
- Status: done

### Decision log

## T3: Normalize segments into a deterministic speaker-turn body
- Purpose: every transcript reads the same way whatever its source, and a retry builds the same bytes
- Covers: R2.1, R2.3, R2.4, R2.5
- Size: S
- Depends on: T2
- Files: src/meetings/normalize.ts, tests/meetings-normalize.test.ts
- Verify: `npm test -- tests/meetings-normalize.test.ts`; `npm run typecheck`; `npm run lint`; `normalizeSegments(segments, unknownLabel)` returns `{ body, turns }`; table cases: consecutive segments of one speaker merge into one turn `**<speaker>** [HH:MM:SS]` with the text on the next line and the first segment's offset (offset 3725 s renders `[01:02:05]`); turns are separated by one blank line; an empty speaker label becomes `unknownLabel`; text is NFC (a decomposed `é` input equals the composed output), CRLF and CR become LF, runs of spaces and tabs between words become one space; segments empty after that are dropped and do not split a turn; segments are ordered by start time with equal times keeping delivered order; a transcript with no text gives `turns: 0`; case "determinism": normalizing the same input twice gives byte-identical `body`, and a shuffled copy with distinct start times gives the same body
- Issue: #198
- Status: done

### Decision log

## T4: Pick the calendar event and route the meeting to an area
- Purpose: a meeting takes the name of the event the owner scheduled and lands in the area the owner's rules choose, with no code change
- Covers: R4.1, R4.2, R5.1, R5.2
- Size: M
- Depends on: T1, T2
- Files: src/meetings/calendar.ts, src/meetings/area.ts, tests/meetings-calendar.test.ts, tests/meetings-area.test.ts
- Verify: `npm test -- tests/meetings-calendar.test.ts tests/meetings-area.test.ts`; `npm run typecheck`; `npm run lint`; `pickEvent(events, start, end)` returns the event with the longest overlap, ties broken by earlier start then smaller id (named cases "longest overlap wins", "tie earlier start", "tie smaller id"); all-day events (`start.date`), `status: "cancelled"` and events where the `self` attendee has `responseStatus: "declined"` are never chosen; no overlapping event gives undefined; `routeArea(event, input, cfg)` returns the area of the first rule in configuration order that matches the event's `calendar_id` or the email domain (case-insensitive) of the organizer, the event organizer or any participant; case "first rule wins" with two matching rules; no match gives `default_area`, and with `default_area: null` the first configured area
- Issue: #199
- Status: done

### Decision log

## T5: Build the note path from the event title, the local date and the area folder
- Purpose: every meeting gets a safe, readable path `YYYY-MM-DD · <title>.md` in the right meetings folder, or a stable untitled name when no event or no usable title exists
- Covers: R4.3, R4.4, R4.5, R5.3
- Size: M
- Depends on: T1, T2
- Files: src/meetings/name.ts, tests/meetings-name.test.ts
- Verify: `npm test -- tests/meetings-name.test.ts`; `npm run typecheck`; `npm run lint`; `meetingTitle` and `meetingPath` compute the date and `HH-MM` in the configured time zone (case "date in time zone": 2026-10-31T03:30Z with `America/Bogota` gives `2026-10-30` and `22-30`); with an event the base name is `YYYY-MM-DD · <title>`; with no event it is `YYYY-MM-DD · <untitled_label> HH-MM`; each run of `<>:"/\|?*[]#^` and control characters becomes one space, spaces collapse, leading and trailing spaces and dots are trimmed; a 400-character title is cut so the full relative path is at most 255 characters; a title empty after cleaning, or one the scrubber matches (a fixture secret from tests/fixtures/scrub), gives the untitled name; the folder is the meeting type's folder with `{area}` replaced (`work/meetings` with the defaults); an exported `withTimeSuffix(base, start, cfg)` appends ` HH-MM` for the collision rule used by T11
- Issue: #200
- Status: done

### Decision log

## T6: Build the meeting frontmatter under the owner's property names
- Purpose: every meeting note carries the properties the owner's Bases and the analysis skill read, with participants listed once and absent values left out
- Covers: R6.1, R6.2, R6.4, R1.7
- Size: M
- Depends on: T1, T2
- Files: src/meetings/frontmatter.ts, tests/meetings-frontmatter.test.ts
- Verify: `npm test -- tests/meetings-frontmatter.test.ts`; `npm run typecheck`; `npm run lint`; `meetingFrontmatter(input, choice, cfg, persons)` writes `type` (meeting value), `area`, `date`, `source` (configured source value) and `source_id` (`<source value>:<id>`) under the owner's canonical names, and start, end (ISO 8601 with the time zone's offset, case "offset -05:00" for America/Bogota), duration in whole minutes rounded down (46 min 45 s gives 46), participants, calendar event id, source title and source URL under the configured meeting names; case "renamed properties": a config mapping `duration` to `minutos` and `source_id` to `origen` writes only those names; participants keep delivered order and drop duplicates by email, then by name, case-insensitive; a participant whose name matches a given person base name (case-insensitive) is a `[[<base name>]]` wikilink, others are plain name, or email when there is no name; case "absent values omitted": no chosen event gives no calendar event key and an undefined source URL (non-https input after T2) gives no source URL key, neither written as null; key order matches design.md "Data model"
- Issue: #201
- Status: done

### Decision log

## T7: Match the other source's version of the same meeting
- Purpose: the Fireflies and Gemini recordings of one meeting are recognized as two versions, never two notes of the same source
- Covers: R7.1, R7.4, R7.5, R7.6
- Size: S
- Depends on: T2
- Files: src/meetings/versions.ts, tests/meetings-versions.test.ts
- Verify: `npm test -- tests/meetings-versions.test.ts`; `npm run typecheck`; `npm run lint`; `matchVersion(input, eventId, candidates)` returns the path of a candidate of the other source with the same calendar event id, or with a time range overlapping at least 50% of the shorter recording (cases "49% does not match", "50% matches"); with several qualifying candidates it returns the one with the longest overlap, ties by smaller path; a candidate of the same source never matches even with the same event id; exported `isVersionCandidate(note, newDate, cfg)` keeps only meeting notes outside the archive folder whose date is within one day of the new meeting's date (cases "archived note ignored", "two days apart ignored", "one day apart kept")
- Issue: #202
- Status: done

### Decision log

## T8: Add the POST /meetings route with its limits and the transcript_not_ready code
- Purpose: n8n has one authenticated route for both sources that answers clear codes for bad input before any git command runs
- Covers: R1.2, R1.4, R1.5, R1.6
- Size: M
- Depends on: T2
- Files: src/server/app.ts, src/server/errors.ts, tests/meetings-route.test.ts, tests/app.test.ts
- Verify: `npm test -- tests/meetings-route.test.ts tests/app.test.ts tests/auth.test.ts tests/mcp-write-tools.test.ts`; `npm run typecheck`; `npm run lint`; `createApp` takes an optional `meetings` writer (interface `{ writeMeeting(input: MeetingInput): Promise<MeetingOk> }` from src/meetings/types.ts) and registers `POST /meetings` after the existing token middleware with a 4 MiB body limit; with a fake writer: no or wrong token gives 401 `unauthorized` and the fake writer records zero calls; a 4 MiB plus 1 byte body gives 413 `payload_too_large`; `text/plain` gives 415 `unsupported_media_type`; malformed JSON gives 400 `invalid_json`; a schema failure gives 400 `invalid_body` with field paths and no received value; an unfinished Gemini transcript gives 409 `transcript_not_ready`; a valid body calls the writer once with the mapped input and returns 201 for a stored result and 200 for `already_stored` and `skipped`; errors.ts gains `transcript_not_ready` (409) while the MCP tool mapping is unchanged; `/notes` routes keep the 1 MiB limit (case "notes limit unchanged": 1 MiB plus 1 byte is 413)
- Issue: #203
- Status: done

### Decision log

## T9: Start the meeting writer: queue slot, meeting config, skips and already stored
- Purpose: inside the existing serialized write queue a meeting request pulls, checks the meeting config, drops short and empty recordings, and answers a redelivered transcript without touching the vault
- Covers: R3.1, R3.2, R3.3, R8.1
- Size: M
- Depends on: T1, T2, T3
- Files: src/vault/write-meeting.ts, src/vault/write-note.ts, tests/write-meeting.test.ts, tests/meetings-retry.integration.test.ts
- Verify: `npm test -- tests/write-meeting.test.ts tests/meetings-retry.integration.test.ts tests/notes.integration.test.ts tests/sync.integration.test.ts`; `npm run typecheck`; `npm run lint`; the writer returned by `createNoteWriter` gains `writeMeeting(input)` that runs in the same queue as `write`, `patch` and `archive` (case "meeting and note writes are serialized" with two concurrent calls), after `syncBeforeWrite` and `loadVaultConfig`, then `requireMeetingSetup`; a recording of exactly `min_minutes` (5:00) returns `{ ok: true, commit: null, skipped: "too_short" }` and 5:01 returns no `skipped` field; zero turns after normalization returns `skipped: "empty_transcript"`; each skip leaves HEAD and `git status` unchanged and logs exactly one line holding the source and the reason, with no planted title, name or transcript marker; integration against a bare fixture remote: a note already holding `source_id: fireflies:<id>` makes a second `writeMeeting` call return `{ ok: true, path: <that note>, commit: null, already_stored: true }` and no new commit and no changed file (the existing `/notes` 409 `duplicate_source` behavior is unchanged)
- Issue: #204
- Status: done

### Decision log

## T10: Store a meeting note through the vault write path and wire it into the app
- Purpose: a valid meeting becomes a committed, pushed note, validated and scrubbed like any other, with participants linked to the owner's existing person notes
- Covers: R1.1, R6.3, R6.5, R8.6
- Size: M
- Depends on: T4, T5, T6, T8, T9
- Files: src/vault/write-meeting.ts, src/vault/write-note.ts, src/index.ts, tests/meetings.integration.test.ts, tests/fixtures/meetings/fireflies-basic.json, tests/fixtures/meetings/gemini-basic.json
- Verify: `npm test -- tests/meetings.integration.test.ts`; `npm run typecheck`; `npm run lint`; `npm run build`; src/index.ts passes the writer to `createApp` as `meetings`; against a bare fixture remote through `createApp`: `POST /meetings` with a fictional Fireflies body returns 201 with `path` under `<area>/meetings/` and a `commit` equal to the remote's HEAD, commit message `2brain: add meeting <path>`; case "person link": with `people/Ana Ruiz.md` in the vault the participant `ana ruiz` is written `[[Ana Ruiz]]` and others stay plain text, with person names read from the folder listing only; case "write path": spies on `validateFrontmatter` and `scrubNote` each record exactly one call for the new note, and the stored file passes `validateFrontmatter` with the vault config; case "scrub": a fixture secret in the transcript, the title and a participant name is stored redacted and the response carries `redactions` with rule names and counts only, no secret in the file, the commit message or the log
- Issue: #205
- Status: done

### Decision log

## T11: Link the second version and resolve path collisions in one commit
- Purpose: the Fireflies and Gemini versions of one meeting sit side by side, each linking the other, with both stored bodies untouched
- Covers: R4.6, R7.2, R7.3, R8.3
- Size: M
- Depends on: T7, T10
- Files: src/vault/write-meeting.ts, tests/meetings-versions.integration.test.ts
- Verify: `npm test -- tests/meetings-versions.integration.test.ts`; `npm run typecheck`; `npm run lint`; against a bare fixture remote: a Gemini meeting arriving after a Fireflies one with the same calendar event id is stored in the first note's folder as `<first base name> (Gemini).md`, the first file keeps its name, both notes' `versions` hold a wikilink to the other, and exactly one new commit names both paths (`2brain: add meeting <path> (version of <other path>)`); case "bodies byte-identical": the first note's body bytes before and after are equal and the stored body of a stored meeting never changes through `POST /meetings`; case "commit fails": a git double failing `commitPaths` leaves no new file and the first note's frontmatter equal to its HEAD bytes, answer 500 `write_failed`; case "collision": a path taken by another meeting (other source id, not a version) gets ` HH-MM` appended, and when that path is also taken the answer is 409 `note_exists` with nothing written
- Issue: #206
- Status: done

### Decision log

## T12: Deliver pending pushes and refuse invalid config on meeting requests
- Purpose: a failed push is never lost, a redelivery delivers it, an invalid config answers 503 to meetings, and a pushed config change applies without a restart
- Covers: R8.2, R8.4, R8.5, R10.4
- Size: M
- Depends on: T11
- Files: src/vault/write-meeting.ts, tests/meetings-failures.integration.test.ts
- Verify: `npm test -- tests/meetings-failures.integration.test.ts`; `npm run typecheck`; `npm run lint`; against a bare fixture remote with a push double: a push failing after its retries returns 502 `push_pending` with the local commit id, and the next meeting request pushes it; case "already stored delivers pending": a redelivery of that meeting pushes the waiting commit and returns 200 `already_stored` only when the push lands, else 502 `push_pending`; case "invalid config": an unknown key under `meetings` and a missing meeting type each return 503 `config_invalid` naming `.2brain/config.yaml` and the key path, with HEAD and the working tree unchanged, while `POST /notes` still answers 201 for the missing meeting type case; case "config change after pull": a commit pushed to the remote that sets `meetings.untitled_label` to `Reunión sin título` is applied to the next request (the untitled name uses it) with the same writer instance
- Issue: #207
- Status: done

### Decision log

## T13: Prove byte-exact notes from recorded fixtures and zero LLM calls
- Purpose: both real API shapes produce the expected note byte for byte, and meeting ingest can never reach a model
- Covers: R2.6, R2.7, R9.1, R9.2
- Size: M
- Depends on: T11, T12
- Files: tests/meetings-fixtures.integration.test.ts, tests/meetings-imports.test.ts, tests/fixtures/meetings/fireflies-recorded.json, tests/fixtures/meetings/fireflies-recorded.expected.md, tests/fixtures/meetings/gemini-recorded.json, tests/fixtures/meetings/gemini-recorded.expected.md
- Verify: `npm test -- tests/meetings-fixtures.integration.test.ts tests/meetings-imports.test.ts`; `npm run typecheck`; `npm run lint`; fixtures follow the Fireflies GraphQL `transcript` and Google Meet REST API shapes with fictional people and `example.com` only; case "fireflies byte exact" and "gemini byte exact": ingesting each fixture through `createApp` against a bare fixture remote writes a file equal to its `.expected.md` byte for byte, the Gemini note taking each speaker from its participant's display name; case "zero LLM calls": with `vi.mock` of src/llm/index.js returning `createMockProvider([])` (src/llm/mock.ts throws when it has no response left and records each call), ingesting both fixtures through `createApp` stores both meetings, and the mock's `calls` is empty; the import-graph test walks the static imports of every file under src/meetings, src/sources/fireflies, src/sources/gemini and src/vault/write-meeting.ts transitively and finds no path under src/llm and no `@anthropic-ai/sdk`
- Issue: #208
- Status: done

### Decision log

## T14: Ship the Fireflies template with poll and webhook triggers, fetch and calendar
- Purpose: an owner imports one Fireflies workflow that works on a plan without webhooks, reacts only to finished transcripts in webhook mode, and never posts a meeting without its calendar
- Covers: R11.3, R11.6, R11.9, R11.10
- Size: M
- Depends on: none
- Files: n8n/templates/meetings-fireflies.json, tests/n8n-fireflies.test.ts, tests/helpers/n8n-template.ts
- Verify: `npm test -- tests/n8n-fireflies.test.ts`; `npm run typecheck`; `npm run lint`; tests/helpers/n8n-template.ts loads a template and finds nodes by type and name; the template parses as an n8n workflow export (`nodes` and `connections`, every connection names an existing node); the Schedule trigger is enabled with an interval read from the `Settings` node (`poll_interval_minutes` default 60) and exactly one Fireflies GraphQL list node (`transcripts` with `fromDate` 24 hours back and `limit: 50`) per poll path; the Webhook trigger is `disabled: true`, its path is a placeholder the guide names, and an IF node passes only the "Transcription completed" event; the fetch node queries `transcript(id)` by id; the Fireflies fetch and calendar nodes have `retryOnFail: true`, `maxTries: 3`, and on final failure route to a stop path that reaches no node posting to the ingest route (case "no post without calendar", checked over the connection graph), except the rate-limit branch left to T16
- Issue: #209
- Status: done

### Decision log

## T15: Ship the Gemini template and check both templates for URL, credentials and secrets
- Purpose: an owner imports a Gemini workflow that reads finished Meet transcripts with every page of entries, and neither template carries a secret or owner data
- Covers: R11.1, R11.2, R11.4, R11.5
- Size: M
- Depends on: T14
- Files: n8n/templates/meetings-gemini.json, tests/n8n-gemini.test.ts, tests/n8n-templates.test.ts
- Verify: `npm test -- tests/n8n-gemini.test.ts tests/n8n-templates.test.ts`; `npm run typecheck`; `npm run lint`; meetings-gemini.json parses as an n8n workflow export; it runs on a Schedule trigger, lists `conferenceRecords` with an end-time filter of the last 24 hours, reads transcripts and follows `nextPageToken` for entries until none is left, and posts only transcripts in the finished state; for both templates: the post node targets exactly `http://brain:3000/meetings` with the `2brain ingest` Header Auth credential referenced by name; the calendar query spans from 30 minutes before the recording start to 30 minutes after its end and the events are passed as delivered (no mapping node between the calendar node and the post); case "no secrets": neither file holds a credential `id`, a bearer token, an API key pattern from the scrub rules, an email whose domain is not `example.com`, or a name from a planted owner list; for meetings-gemini.json, the Meet API and calendar nodes have `retryOnFail: true` and `maxTries: 3`, and on final failure reach no node that posts to the ingest route (case "gemini no post without calendar", checked over the connection graph)
- Issue: #210
- Status: done

### Decision log

## T16: Add the Fireflies poll state node: selection, daily budget, rate limit, pending ids
- Purpose: the Fireflies poll fetches only new transcripts, stays under the owner's daily request budget, stops on a rate limit and loses nothing it could not post
- Covers: R11.11, R11.13, R11.14, R11.15
- Size: M
- Depends on: T14
- Files: n8n/templates/meetings-fireflies.json, tests/n8n-poll-state.test.ts, tests/helpers/n8n-code-node.ts
- Verify: `npm test -- tests/n8n-poll-state.test.ts`; `npm run typecheck`; `npm run lint`; tests/helpers/n8n-code-node.ts extracts the `jsCode` of the Code node named `Poll state` from the template JSON and runs it with fake workflow static data and inputs; cases: "new versus posted" (listed plus pending minus posted is fetched, one fetch request per id); "48 h expiry" (a posted entry 49 hours old is dropped and fetched again if listed); "budget reserve" (with `daily_budget` 40 and `used` 39 the list request is reserved and no fetch is; with `used` 40 the poll ends with no request); "UTC day reset" (`used` returns to 0 when `day` changes); "retries counted" (3 tries of one fetch add 3 to `used`); "rate limit stop" (an HTTP 429 or a GraphQL error with code `too_many_requests` makes no further Fireflies request in the execution and keeps the remaining ids pending); "pending past the window" (a pending id no longer listed is still fetched in a later poll); static data holds only ids, timestamps, `day` and `used`
- Issue: #211
- Status: done

### Decision log
- 2026-11-01: fetch retries move into `Poll state` (counted against the budget, no retry on a rate limit); the `retryOnFail` claim in T14 Verify now applies to Calendar only; the webhook path passes `Settings` and `Poll state`.

## T17: Record ingest answers in the poll state and retry posts on 502 and 503
- Purpose: a safe repeat counts as posted, a refused transcript shows as a failed execution, and a busy or misconfigured service is retried without duplicates
- Covers: R11.7, R11.12, R11.16
- Size: M
- Depends on: T15, T16
- Files: n8n/templates/meetings-fireflies.json, n8n/templates/meetings-gemini.json, tests/n8n-poll-state.test.ts, tests/n8n-templates.test.ts
- Verify: `npm test -- tests/n8n-poll-state.test.ts tests/n8n-templates.test.ts`; `npm run typecheck`; `npm run lint`; `Poll state` runs as the last node on every path of the Fireflies template (checked over the connection graph); cases: "already stored counts as posted" (a 200 `already_stored` answer moves the id into `posted`); "201 counts as posted"; "4xx drop" (a 400 or 409 answer removes the id from `pending` and routes to a `Stop and Error` node); "502 and 503 stay pending" (after the post retries the id stays in `pending`); for both templates the post node retries only on 502 and 503, 3 times, with a wait of at least 60 seconds between tries, and a 4xx answer is not retried
- Issue: #212
- Status: done

### Decision log
- 2026-11-01: post retries are 3 retries (4 posts) 60 s apart; a 4xx answer removes the id from `pending` and also records it in `posted`, so a refused id is not fetched again for 48 h; the Fireflies round is serial and any stop is emitted when the round ends.

## T18: Write the meetings guide and link it from the install guide
- Purpose: a third-party owner connects Fireflies and Gemini, sets the meetings config and stays within the Fireflies limit without reading code
- Covers: R12.1, R12.2, R12.3
- Size: M
- Depends on: T1, T17
- Files: docs/GUIDE-meetings.md, docs/INSTALL.md, tests/guide-meetings.test.ts
- Verify: `npm test -- tests/guide-meetings.test.ts tests/guide-install.test.ts`; `npm run lint`; docs/INSTALL.md links `GUIDE-meetings.md`; the guide has a section for each of: importing both templates, the credential names (`2brain ingest` and the source credentials as named in the templates), choosing poll or webhook mode, `poll_interval_minutes` and `daily_budget`, replacing the webhook path with a random value, activating the workflow (static data), confirming the Workspace edition and enabling the Google Meet REST API, the `meetings` config section with an example equal to the template defaults plus one area rule, adding `fireflies` and `gemini` to an existing `sources` allow-list, and the skip and retry behavior; it states checking the Fireflies plan's daily API request limit as a prerequisite and how interval and budget keep under it; case "no price": no currency symbol or `USD`; case "no owner data": no email outside `example.com`, no name from a planted owner list, no em dash
- Issue: #213
- Status: done

### Decision log

## T19: Import both templates and run them on the owner's real accounts (manual check)
- Purpose: the owner confirms on real Fireflies, Google Workspace and n8n accounts that one meeting from each source reaches the vault, the Fireflies mode fits the plan, the daily budget holds, and the Meet API needs no billing
- Covers: R11.8, R11.17, R11.18
- Size: S
- Depends on: T13, T17, T18
- Files: docs/GUIDE-meetings.md
- Verify: manual, reasons from requirements.md: R11.8 needs the owner's Fireflies, Google Workspace and n8n accounts, the webhook or poll choice is confirmed on the real plan; R11.17 needs the owner's real Fireflies account, plan and meeting volume; R11.18 the Workspace edition and the Cloud project belong to the owner and are checked by the owner. Steps: import both templates into n8n 2.39.8 following docs/GUIDE-meetings.md, Fireflies in webhook mode only if the plan offers webhooks; one real meeting per source appears as a note in the vault repository; after one day of usual meetings the template's counted Fireflies requests are at or below `daily_budget` and the n8n executions list shows no rate-limit error; the Google Cloud project with the Meet REST API enabled shows no billing account and the Gemini template reads one conference record and its entries. Pass is the owner's yes on each of the three checks on the issue
- Issue: #214
- Status: todo

### Decision log

## T20: Run one real meeting recorded by both sources through to analysis (manual check)
- Purpose: the owner sees the whole flow on a real meeting: two linked notes in the right folder on time, and the analysis skill reading both
- Covers: R13.1, R13.2
- Size: S
- Depends on: T19
- Files: docs/GUIDE-meetings.md
- Verify: manual, reasons from requirements.md: R13.1 needs the owner's accounts and a real meeting; R13.2 runs in the owner's interactive subscription session. Steps: record one real meeting with both Fireflies and Gemini; within 60 minutes of the later transcript being ready in webhook mode, or within the poll interval plus 30 minutes in poll mode (90 minutes with the defaults), two notes named after the calendar event appear in the right area folder with `versions` linking each other; run `analizar-reunion` on it and check that it read both versions, saved the analysis next to them, and `git diff` of both meeting notes' bodies is empty. Pass is the owner's yes on both checks on the issue
- Issue: #215
- Status: todo

### Decision log
