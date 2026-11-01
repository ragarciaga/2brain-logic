# Requirements: Meetings without LLM

Status: approved  |  Date: 2026-11-01  |  Spec: docs/specs/05-meetings/
Baseline: 40 h
Brief: docs/brief.md  |  ADRs: docs/adr/0003-thin-n8n.md, docs/adr/0004-meetings-without-llm.md, docs/adr/0006-configuration-driven.md, docs/adr/0010-ingest-bearer-token.md, docs/adr/0011-note-write-operations.md, docs/adr/0012-vault-config-mapping.md, docs/adr/0018-meeting-versions-as-linked-notes.md, docs/adr/0019-meeting-ingest-contract.md, docs/adr/0020-meetings-config-section.md

## Context
Meeting transcripts from Fireflies and Google Meet (Gemini) stay in those tools and are uploaded
by hand when the owner wants to analyze them. This feature lets n8n hand each finished transcript
to a new ingest route that normalizes it, names it from the overlapping calendar event, drops
recordings of 5 minutes or less, places it in the area's meetings folder, links the two versions
of one meeting, and commits it, with zero LLM calls (ADR 0004). Analysis stays in the owner's
subscription through the existing `analizar-reunion` skill (F3 R9), which reads these notes.

## Users
- n8n workflows (machine callers on the internal network): post a finished transcript once (or
  again after a failure) and get a clear outcome they can act on (stored, already stored,
  skipped, retry later).
- The vault owner: finds every real meeting in the right area folder, named after the calendar
  event, with its participants and both versions linked, and the transcript exactly as delivered.
- A third party installing the product: imports two n8n templates, maps credential names, sets
  the meeting section of the vault config, and changes no code.

## Out of scope
- Meeting analysis, summaries and speaker identification ("Speaker 1" to a name): the
  `analizar-reunion` skill does them in the owner's subscription (ADR 0004).
- Renaming or deleting transcripts in Fireflies (the "delete after days" option): irreversible
  change to the owner's data in a third party, plan-dependent and rate-limited API (tracked in
  docs/v2.md).
- Creating person notes from attendee lists: the plugin and the owner create person notes; the
  meeting note only links existing ones (tracked in docs/v2.md).
- Renaming a stored meeting when its calendar event changes later: file names are stable once
  stored (tracked in docs/v2.md).
- Backfill of historical transcripts and other meeting sources (Zoom, Teams, Otter): tracked in
  docs/v2.md.
- Storing audio or video: the note keeps only the source link.
- Tasks from meetings: they belong to the owner's task tool (AGENTS.md, Out of scope).

## Existing behavior to preserve
- Every route except `GET /health` requires `Authorization: Bearer <INGEST_TOKEN>`
  (src/server/app.ts:83, src/auth/ingest-token.ts): verified by tests/auth.test.ts `[unit]`
- `POST /notes`, `PATCH /notes` and `POST /notes/archive` keep their contracts, codes and the
  1 MiB body limit (src/server/app.ts:19, 42 to 127): verified by tests/app.test.ts and
  tests/notes.integration.test.ts `[integration]`
- The `meeting` type is `immutable_body: true`: a PATCH append is 409 `immutable_body`, property
  changes are accepted (src/config/defaults.ts:208, src/vault/write-note.ts:513 to 609): verified
  by tests/patch.integration.test.ts and tests/operations.test.ts `[integration]`
- A create whose `source_id` belongs to another note is 409 `duplicate_source`
  (src/vault/write-note.ts:458 to 470, src/vault/source-index.ts): verified by
  tests/notes.integration.test.ts and tests/source-index.test.ts `[integration]`
- Body and every string frontmatter value (nested lists included) are scrubbed before the write,
  and a path that matches a scrub rule is refused (src/vault/write-note.ts:204 to 250, 372 to 378,
  src/vault/scrub/index.ts:223): verified by tests/scrub.test.ts and tests/notes.integration.test.ts
  `[integration]`
- Frontmatter validation and the type folder rule (src/vault/validate.ts:135 to 183): verified by
  tests/validate.test.ts `[unit]`
- The vault config schema is strict, re-read after each pull, and the code defaults equal
  vault-template/.2brain/config.yaml (src/config/vault-config.ts:120, src/config/defaults.ts):
  verified by tests/vault-config.test.ts and tests/template.test.ts `[unit]`
- Serialized writes, pull with rebase before each write, conflict copies, push retries and
  `push_pending` delivery (src/git/sync.ts): verified by tests/sync.integration.test.ts
  `[integration]`
- One error table shared by the ingest routes and the MCP tools (src/server/errors.ts:152):
  verified by tests/app.test.ts and tests/mcp-write-tools.test.ts `[unit]`
- The `analizar-reunion` skill sets only the `analysis` property on meeting notes through
  `update_properties` and reads meeting notes through `search`, `recent` and `read`
  (plugin/skills/analizar-reunion/SKILL.md): verified by tests/plugin/skill.test.ts `[unit]`

## R1: Meeting ingest route
As an n8n workflow, I want one authenticated route that accepts a finished Fireflies or Gemini
transcript, so that each source needs only a thin template.

- R1.1 When `POST /meetings` receives a valid Fireflies or Gemini payload with the ingest token,
  the system shall store the meeting note, commit, push and respond 201 with the note path and
  the commit id. `[integration]`
- R1.2 If a request to `POST /meetings` lacks a valid ingest token, then the system shall respond
  401 `unauthorized` without running any git command. `[unit]`
- R1.3 If the payload does not match the schema of its `source` (missing field, wrong type,
  unknown `source`, end not after start, a recording longer than 12 hours, more than 50,000
  transcript segments, more than 500 participants or more than 50 calendar events), then the
  system shall respond 400 `invalid_body` listing the field paths and messages without any
  received value, and write nothing. `[unit]`
- R1.4 If the request body is larger than 4 MiB, then the system shall respond 413
  `payload_too_large` and write nothing. `[unit]`
- R1.5 If the content type is not `application/json` or the body is not valid JSON, then the
  system shall respond 415 `unsupported_media_type` or 400 `invalid_json` respectively. `[unit]`
- R1.6 If a Gemini transcript is not in a finished state, then the system shall respond 409
  `transcript_not_ready` and write nothing. `[unit]`
- R1.7 If a source URL is present and is not an `https` URL, then the system shall store the note
  without the source URL property. `[unit]`

## R2: Deterministic normalization
As the owner, I want both sources stored in one readable shape, so that every transcript reads
the same way and a retry produces the same bytes.

- R2.1 When a transcript arrives as timed segments, the system shall write the body as one block
  per speaker turn, `**<speaker>** [HH:MM:SS]` followed by the turn's text on the next line,
  merging consecutive segments of the same speaker into one turn that carries the first
  segment's offset from the recording start. `[unit]`
- R2.2 The system shall store speaker labels exactly as the source delivered them (after Unicode
  NFC and whitespace trimming), including generic labels such as "Speaker 1". `[unit]`
- R2.3 If a segment has an empty speaker label, then the system shall use the configured unknown
  speaker label for that segment. `[unit]`
- R2.4 The system shall normalize segment text to Unicode NFC, LF line endings and single spaces
  between words, drop segments whose text is empty after that, and order segments by start time
  keeping the delivered order for equal times. `[unit]`
- R2.5 When the same payload is normalized twice, the system shall produce byte-identical note
  content. `[unit]`
- R2.6 When a Fireflies payload recorded from the Fireflies API (fictional fixture) is ingested,
  the system shall produce the expected note byte for byte. `[integration]`
- R2.7 When a Gemini payload recorded from the Google Meet API (fictional fixture) is ingested,
  the system shall produce the expected note byte for byte, with each entry's speaker taken from
  the display name of its participant. `[integration]`
- R2.8 If a Gemini transcript entry names a participant missing from the participant list, then
  the system shall use the configured unknown speaker label for that entry. `[unit]`

## R3: Short and empty recordings
As the owner, I want test calls and accidental recordings left out, so that the meetings folder
holds only real meetings.

- R3.1 If the recording lasts the configured minimum (default 5 minutes) or less, then the system
  shall respond 200 with `skipped: "too_short"`, make no commit and write nothing. `[unit]`
- R3.2 If the transcript has no segment with text after normalization, then the system shall
  respond 200 with `skipped: "empty_transcript"`, make no commit and write nothing. `[unit]`
- R3.3 When a recording is skipped, the system shall log one line with the source and the skip
  reason, without the title, names or transcript text. `[unit]`

## R4: Name from the calendar
As the owner, I want each meeting named after its calendar event, so that I find it by the name
I scheduled.

- R4.1 When one or more calendar events in the payload overlap the recording, the system shall
  name the note `YYYY-MM-DD · <event title>.md`, using the event with the longest overlap (ties:
  earlier start, then smaller event id) and the recording's start date in the configured time
  zone. `[unit]`
- R4.2 The system shall ignore all-day events, cancelled events and events the owner declined
  when choosing the event. `[unit]`
- R4.3 If no calendar event overlaps the recording, then the system shall name the note
  `YYYY-MM-DD · <untitled label> HH-MM.md`, with the configured untitled label and the local
  start time, and keep the source's own title in the source title property. `[unit]`
- R4.4 The system shall replace every run of characters that a note path or an Obsidian link
  forbids (`<>:"/\|?*[]#^` and control characters) in a title with one space, collapse spaces, trim leading
  and trailing spaces and dots, and cut the title so the full path stays within 255 characters.
  `[unit]`
- R4.5 If the cleaned title is empty or matches a scrub rule, then the system shall use the
  untitled name of R4.3. `[unit]`
- R4.6 If the chosen path already holds a note of another meeting, then the system shall add the
  local start time ` HH-MM` to the title, and if that path is also taken, respond 409
  `note_exists` and write nothing. `[integration]`

## R5: Area and folder
As the owner, I want work meetings in my work area and the rest in my default area, without code
changes.

- R5.1 When a configured area rule matches the chosen calendar event's calendar id, or the email
  domain of the organizer or of any participant, the system shall store the note in that rule's
  area; the first matching rule in configuration order wins. `[unit]`
- R5.2 If no area rule matches, then the system shall store the note in the configured default
  area (the first configured area when none is set). `[unit]`
- R5.3 The system shall store the note in the meeting type's folder with `{area}` replaced by the
  chosen area. `[unit]`

## R6: Frontmatter and links
As the owner, I want each meeting note to carry the properties my Bases and the analysis skill
rely on.

- R6.1 The system shall write the configured `type` (meeting value), `area`, `date`, `source`
  (the configured value of the source) and `source_id` (`<source>:<id from the source>`)
  properties under the owner's property names. `[unit]`
- R6.2 The system shall write the meeting properties start and end (ISO 8601 with the configured
  time zone's offset), duration in whole minutes (rounded down), participants, calendar event id
  (when an event was chosen), source title and source URL, under the configured meeting property
  names. `[unit]`
- R6.3 When a participant's display name equals the base name of an existing person note
  (case-insensitive), the system shall list that participant as a wikilink to the note; other
  participants are listed as plain text, by name when the source gives one, otherwise by email.
  `[integration]`
- R6.4 The system shall list each participant once, in the order the source delivered them,
  removing duplicates by email and then by name (case-insensitive). `[unit]`
- R6.5 The system shall pass every meeting note through the vault write path, so it is validated,
  scrubbed and deduplicated like any other note. `[integration]`

## R7: Two versions of one meeting
As the owner, I want the Fireflies and Gemini versions of the same meeting kept side by side and
linked, so that the analysis skill reads both without me finding them.

- R7.1 When a meeting arrives and a meeting note from the other source exists with the same
  calendar event id, or with a time range that overlaps at least 50% of the shorter recording,
  the system shall treat both as versions of one meeting. `[unit]`
- R7.2 When a second version is stored, the system shall place it in the first version's folder
  and name it `<first version's base name> (<source label>).md`, leaving the first version's
  name unchanged. `[integration]`
- R7.3 When a second version is stored, the system shall set the versions property of each note
  to a wikilink to the other note, in one commit, without changing any byte of either body.
  `[integration]`
- R7.4 If several notes of the other source qualify, then the system shall link the one with the
  longest overlap (ties: smaller path). `[unit]`
- R7.5 The system shall never treat two notes of the same source as versions of one meeting.
  `[unit]`
- R7.6 The system shall look for versions only among meeting notes outside the archive folder
  whose date is within one day of the new meeting's date. `[unit]`

## R8: Retries and an immutable transcript
As an n8n workflow, I want to send the same transcript again safely, so that a failed run can be
retried without duplicates or changed transcripts.

- R8.1 If the `source_id` of the payload already belongs to a note, then the system shall respond
  200 with `already_stored: true` and that note's path, and change no file. `[integration]`
- R8.2 When a request answered `already_stored` finds a local commit waiting to be pushed, the
  system shall push it and respond 200 only if the push lands, otherwise 502 `push_pending`.
  `[integration]`
- R8.3 The system shall never change the body of a stored meeting note through `POST /meetings`;
  only its versions property may change (R7.3). `[integration]`
- R8.4 If the push fails after its retries, then the system shall respond 502 `push_pending` with
  the local commit id, and the next write shall deliver it. `[integration]`
- R8.5 If the vault config is invalid, then the system shall respond 503 `config_invalid` naming
  the file and key path, and write nothing. `[integration]`
- R8.6 If a scrub rule matches in the transcript, title or participants, then the system shall
  store the redacted text and return `redactions` with rule names and counts only. `[integration]`

## R9: Zero LLM calls
As the owner, I want meeting ingest to cost nothing per meeting, so that the USD 20 cap is never
touched by meetings (ADR 0004).

- R9.1 The meeting ingest modules shall import nothing from `src/llm/` and from
  `@anthropic-ai/sdk`, checked by a test over their import graph. `[unit]`
- R9.2 When a meeting is ingested with an LLM provider that throws on any call wired into the
  process, the system shall store the meeting and the provider shall record zero calls. `[integration]`

## R10: Meeting configuration
As a third-party owner, I want the meeting settings in my vault config, so that my time zone,
areas, labels and property names drive meeting notes without code changes.

- R10.1 When the vault config has no meetings section, the system shall use the defaults shipped
  in `vault-template/.2brain/config.yaml` (time zone UTC, minimum 5 minutes, English labels,
  English property names, no area rules), and the test that keeps code defaults and template
  equal shall pass. `[unit]`
- R10.2 If the meetings section has an unknown key, an area rule or default area that is not a
  configured area, a time zone that is not a valid IANA name, a negative minimum, duplicate
  meeting property names, or a meeting property name equal to a canonical property's owner name,
  then the system shall respond 503 `config_invalid` with the key path to meeting requests.
  `[unit]`
- R10.3 If the configured types have no `meeting` type with a folder, or the source allow-list is
  not empty and lacks a meeting source value, then the system shall respond 503 `config_invalid`
  with the key path to meeting requests and keep accepting other writes. `[unit]`
- R10.4 When a pushed commit changes the meetings section, the system shall apply it to the next
  meeting request after its pull, without a restart. `[integration]`

## R11: n8n templates
As a third-party owner, I want importable workflows for both sources, so that connecting
Fireflies and Gemini is an import and a credential mapping, on the Fireflies plan I already have.

- R11.1 The repository shall ship `n8n/templates/meetings-fireflies.json` and
  `n8n/templates/meetings-gemini.json` that parse as n8n workflow exports and post to
  `http://brain:3000/meetings` through the `2brain ingest` Header Auth credential. `[unit]`
- R11.2 The templates shall contain no credential ids, tokens, keys, email addresses other than
  `example.com`, or owner names; credentials are referenced only by name. `[unit]`
- R11.3 Where the owner enables webhook mode (only when the owner's Fireflies plan offers
  webhooks), the Fireflies template shall react only to the "Transcription completed" event, fetch
  the transcript by its id from the Fireflies API, and listen on a webhook path the guide tells the
  owner to replace with a random value. `[unit]`
- R11.4 The Gemini template shall run on a schedule, read conference records that ended in the
  last 24 hours from the Google Meet API, follow every page of transcript entries, and post only
  transcripts in a finished state. `[unit]`
- R11.5 Both templates shall query the calendar for events from 30 minutes before the recording
  start to 30 minutes after its end, and pass them as delivered. `[unit]`
- R11.6 If the calendar or source API call fails after 3 tries, other than a Fireflies rate-limit
  error (R11.14), then the template shall stop that execution without calling the ingest route,
  so no meeting is ever named without its calendar. `[unit]`
- R11.7 When the ingest route answers 502 or 503, the template shall retry the post 3 times with
  waits of at least 60 seconds, relying on R8.1 for safety. `[unit]`
- R11.8 When the templates are imported into n8n 2.39.8 and run against the owner's real
  accounts, with the Fireflies template in webhook mode if the owner's current plan offers
  webhooks and in poll mode otherwise, one real meeting from each source shall reach the vault.
  `[manual]` (reason: needs the owner's Fireflies, Google Workspace and n8n accounts; the
  webhook or poll choice is confirmed on the real plan)
- R11.9 The Fireflies template shall ship with the scheduled poll trigger enabled and the webhook
  trigger disabled, so that it works on a plan without webhooks. `[unit]`
- R11.10 While in poll mode, the Fireflies template shall run on a schedule with a configurable
  interval (default 60 minutes) and make exactly one Fireflies list request per poll, for
  transcripts dated in the last 24 hours. `[unit]`
- R11.11 When a poll lists transcripts, the Fireflies template shall fetch only the listed or
  pending ids that it has not already posted with a 200 or 201 answer in the last 48 hours, one
  fetch request per id. `[unit]`
- R11.12 When the ingest route answers 200 `already_stored` for a polled transcript, the Fireflies
  template shall count it as posted, so a repeat delivery changes nothing in the vault (R8.1).
  `[unit]`
- R11.13 The Fireflies template shall count every Fireflies API request, retries included, per
  UTC day, and make no Fireflies request that would take the count above a configurable daily
  budget (default 40, below the plan's limit of about 50 a day). `[unit]`
- R11.14 If the Fireflies API answers a rate-limit error (HTTP 429 or a GraphQL error with code
  `too_many_requests`), then the Fireflies template shall make no further Fireflies request in
  that execution, without retrying, and leave the affected transcripts for the next poll.
  `[unit]`
- R11.15 If a listed transcript is not posted with a 200 or 201 answer in a poll (budget reached,
  rate limit, fetch error, or an ingest answer of 502 or 503 after R11.7), then the Fireflies
  template shall keep its id pending and fetch it in a later poll, even after it leaves the
  24-hour list window. `[unit]`
- R11.16 If the ingest route answers a 4xx code for a polled transcript, then the Fireflies
  template shall drop its id from the pending ids and mark that execution as failed, so the owner
  sees it in the n8n executions list. `[unit]`
- R11.17 When the Fireflies template runs for one day of the owner's usual meetings on the
  owner's current Fireflies plan, the Fireflies API requests counted by the template shall stay at
  or below the daily budget and Fireflies shall return no rate-limit error. `[manual]` (reason:
  needs the owner's real Fireflies account, plan and meeting volume)
- R11.18 When the owner has confirmed that the Google Workspace edition produces Meet
  transcripts and has enabled the Google Meet REST API in a Google Cloud project, the Gemini
  template shall read one real conference record and its transcript entries with no billing
  account or paid API attached to that project. `[manual]` (reason: the Workspace edition and the
  Cloud project belong to the owner and are checked by the owner)

## R12: Meetings guide
As a third-party owner, I want one guide for connecting meetings, so that I can do it without
reading code.

- R12.1 The repository shall ship `docs/GUIDE-meetings.md`, linked from docs/INSTALL.md, covering
  import, credential names, choosing poll or webhook mode for Fireflies, the poll interval and
  daily budget settings, the random webhook path for webhook mode, confirming the Workspace
  edition and enabling the Google Meet API, the meetings config section with an example, adding
  the source values to an existing allow-list, and the skip and retry behavior. `[unit]`
- R12.2 The guide shall state the Fireflies API daily request limit of the owner's plan as a
  prerequisite to check, and how to keep the daily budget and poll interval under it, without
  naming a price. `[unit]`
- R12.3 The guide shall contain no owner data (no personal names, domains or emails other than
  `example.com`). `[unit]`

## R13: End to end on the owner's accounts
As the owner, I want the whole flow working with my real meetings.

- R13.1 When a real meeting recorded by both Fireflies and Gemini ends, two linked notes named
  after the calendar event shall appear in the right area folder within 60 minutes of the later
  transcript being ready in webhook mode, or within the poll interval plus 30 minutes in poll mode
  (90 minutes with the defaults). `[manual]` (reason: needs the owner's accounts and a real meeting)
- R13.2 When the owner runs `analizar-reunion` on that meeting, the skill shall read both linked
  versions and save the analysis next to them, with no change to either body. `[manual]`
  (reason: runs in the owner's interactive subscription session)

## Decisions closed for this spec
Closed with the recommended default under the owner's pre-approval of this session; design.md
lists them as RESOLVED.
- D1 Two versions are two linked notes, not one merged body (ADR 0018).
- D2 The first version keeps the plain name; a later version gets ` (<source label>)` (ADR 0018,
  reading of ADR 0004 "source suffix when both sources exist").
- D3 n8n supplies the candidate calendar events; the service holds no Google or Fireflies
  credential and calls no external API (ADR 0019, ADR 0003).
- D4 The service receives the source's own API shapes (Fireflies transcript, Meet conference
  record and entries) and does the mapping, not n8n (ADR 0019, ADR 0003).
- D5 Gemini comes from the Google Meet REST API transcript entries, not from parsing the Google
  Doc export (structured times and speakers).
- D6 No calendar match means `Untitled meeting HH-MM`, as ADR 0004 says; the source title is kept
  in a property.
- D7 A redelivered `source_id` is a 200 `already_stored`, not a 409, for the meeting route only.
- D8 Meeting settings live in a new optional `meetings` section of `.2brain/config.yaml`
  (ADR 0020).
- D9 Participants link only to existing person notes, by base name; no person notes are created.
- D10 Fireflies rename and delete are deferred (docs/v2.md).
- D11 In webhook mode, the Fireflies webhook is not signature-checked; it carries only an id that
  n8n resolves with the owner's own API key, behind a random webhook path.
- D12 Meeting route body limit is 4 MiB; `/notes` keeps 1 MiB.

Answered by the owner on 2026-11-01 (cost questions):
- D13 Fireflies runs on the owner's current plan at USD 0, and the design depends on no paid
  Fireflies feature. The template ships in poll mode (R11.9); webhook mode is enabled only if the
  plan offers webhooks, confirmed at the manual check (R11.8, R11.17).
- D14 The poll stays well under the free limit of about 50 requests a day: one list request per
  poll plus one fetch per new transcript, every 60 minutes, under a daily budget of 40 (24 list
  requests plus 16 fetches; the owner's usual volume, assumed up to 8 meetings a day, uses about
  32). Interval and budget are template settings (R11.10, R11.13).
- D15 A Fireflies rate-limit error ends the poll without retries and loses nothing: unposted ids
  stay pending for the next poll, and the service's `already_stored` answer makes repeats safe
  (R11.12, R11.14, R11.15).
- D16 The Google Meet REST API costs USD 0; the owner confirms the Workspace edition and enables
  the API at the manual check (R11.18).
- D17 No Anthropic spend and no paid eval for this feature (R9); `Paid services` in AGENTS.md is
  unchanged.
- D18 The poll bookkeeping (posted and pending ids, the daily request count) lives in one n8n Code
  node using the workflow's static data, a narrow exception to ADR 0003 for state only n8n can
  keep; its code is unit tested from the template JSON, and all mapping stays in the service
  (ADR 0019).

## Verification summary
| Tag | Count |
|---|---|
| unit | 52 |
| integration | 16 |
| e2e | 0 |
| eval | 0 |
| manual | 5 |
