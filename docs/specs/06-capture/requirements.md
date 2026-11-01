# Requirements: Capture from Telegram and email

Status: draft  |  Date: 2026-11-01  |  Spec: docs/specs/06-capture/
Brief: docs/brief.md  |  ADRs: docs/adr/0002-workflow-vs-agent.md, docs/adr/0003-thin-n8n.md, docs/adr/0006-configuration-driven.md, docs/adr/0008-vault-safety.md, docs/adr/0010-ingest-bearer-token.md, docs/adr/0020-meetings-config-section.md, docs/adr/0021-capture-llm-and-spend-guard.md, docs/adr/0022-speech-to-text-in-n8n.md, docs/adr/0023-email-capture-rule.md

## Context
Ideas sent to oneself in chat and emails worth keeping never reach the vault today. This feature
lets the owner send a text or voice note to their own Telegram bot and get it filed as a
classified idea, and lets n8n hand each recent Gmail thread to the service, which keeps every
thread carrying the owner's label and asks one fixed LLM step about the rest (capture, skip, or
ask the owner on Telegram). One fixed LLM call per item proposes title, area, type and tags,
validated against the config before anything is written; a monthly spend guard keeps it under
the cap, and every failure falls back to an unclassified note or a question, never a lost item.

## Users
- The vault owner: sends ideas by Telegram text or voice and gets a reply with where each was
  saved; finds labelled and relevant emails in the vault; answers save or discard on doubtful
  emails; never pays more than the configured monthly cap.
- n8n workflows (machine callers on the internal network): post one idea or one email thread and
  get an outcome they can act on (stored, already stored, ignored, skip, ask, retry later).
- A third party installing the product: imports two templates, maps four credential names, fills
  the `capture` section of the vault config, and changes no code.

## Out of scope
- Email attachments: size, file types and their own scrub need a separate design.
- Telegram alerts for git conflicts: conflicts stay a log line (brief, Open items); a separate notification flow.
- Moving or reclassifying existing notes: F7 routines; F6 only creates notes.
- Other chat sources (WhatsApp and similar): one chat source first; their APIs need business accounts.
- Multi-user bots or several owners: one owner per install (docs/v2.md, "Several owners").
- Updating a stored email note when its thread gets new messages: one note per thread, stored
  once; a later message answers `already_stored`.
- Meeting analysis and tasks from captured items (AGENTS.md, Out of scope).

## Existing behavior to preserve
The new routes reuse these mechanisms unchanged; the capture route tests (design.md, Testing
strategy) assert each one on `POST /ideas` and `POST /emails` as well.
- Every route except `GET /health` answers 401 `unauthorized` without the ingest bearer token,
  before any git command (src/auth/ingest-token.ts): verified by tests/auth.test.ts `[unit]`
- JSON only: 415 `unsupported_media_type` and 400 `invalid_json`, 413 `payload_too_large` over the
  route's limit, 400 `invalid_body` with field paths and no values (`readJsonBody`, `bodyLimit`,
  `issuesOf` in src/server/app.ts and src/server/errors.ts): verified by tests/app.test.ts `[unit]`
- One error table for ingest routes and MCP tools; a redelivered `source_id` maps to 200
  `already_stored` on ingest routes that opt in, as on `/meetings` (src/server/errors.ts): verified
  by tests/app.test.ts and tests/meetings-route.test.ts `[unit]`
- `POST /notes`, `PATCH /notes`, `POST /notes/archive` (1 MiB) and `POST /meetings` (4 MiB) keep
  their contracts: verified by tests/app.test.ts and tests/notes.integration.test.ts `[integration]`
- Meeting ingest imports nothing from `src/llm/` and makes zero model calls (F5 R9): verified by
  tests/meetings-imports.test.ts and tests/meetings.integration.test.ts `[integration]`
- A `source_id` held by another note is never stored twice (src/vault/source-index.ts): verified
  by tests/source-index.test.ts `[integration]`
- Body and every frontmatter string are scrubbed before a write, `redactions` carry rule names and
  counts only, a path matching a rule is refused: verified by tests/scrub.test.ts and
  tests/notes.integration.test.ts `[integration]`
- An invalid vault config answers 503 `config_invalid` with file and key path; serialized writes,
  pull before write, push retries and 502 `push_pending` with the local commit (src/git/sync.ts):
  verified by tests/sync.integration.test.ts and tests/meetings-retry.integration.test.ts `[integration]`
- The vault config is strict, re-read after each pull, code defaults equal
  vault-template/.2brain/config.yaml, and a bad `meetings` setup blocks only meeting requests:
  verified by tests/vault-config.test.ts, tests/template.test.ts and tests/meetings-config.test.ts `[unit]`

## R1: Capture configuration
As a third-party owner, I want the capture settings in my vault config, so that chat id, types,
criteria, accounts, cap and property names need no code change.

- R1.1 When the vault config has no `capture` section, the system shall load the defaults spelled out in `vault-template/.2brain/config.yaml`, and the test that keeps code defaults and template equal shall pass. `[unit]`
- R1.2 If the `capture` section has an unknown key, a capture type or fallback type that is not a configured type, an account default area that is not an area, an account key that repeats or does not match `^[a-z][a-z0-9_-]*$`, a cap that is not a number from 0 to 1000, or capture property names that repeat or equal a canonical or meeting property name or `analysis`, then the system shall answer capture requests 503 `config_invalid` with the key path of the first problem. `[unit]`
- R1.3 If the owner chat id is empty, the fallback type has a folder other than the inbox folder, the email type has no folder, or a non-empty source allow-list lacks a capture source value, then the system shall answer the affected capture route 503 `config_invalid` with that key path and keep accepting every other write. `[unit]`
- R1.4 When a pushed commit changes the `capture` section, the system shall apply it to the next capture request after its pull, without a restart. `[integration]`

## R2: Model calls and spend guard
As the owner, I want every model call to go through one tested door with a monthly cap, so that
cost, privacy and output stay under control.

- R2.1 When the provider calls the model, the system shall request `claude-haiku-5-5` with low effort, no extended thinking, at most 400 output tokens and a JSON schema output format built from the configured enums, and shall treat a refusal, a `max_tokens` stop, an API error after the SDK retries, or no answer within 30 seconds as a failed call; and if `ANTHROPIC_API_KEY` is not set, the system shall start, log `llm disabled` once without values, and treat every call as failed. `[unit]`
- R2.2 The system shall send the model only text scrubbed with the vault scrub rules and cut to its first 8,000 characters, inside a delimited data block under a fixed system prompt, validate every output against the step's Zod schema before any value reaches a note or a response, log no idea or email text, subject, sender, title, tag or model output, and call a model from the capture modules only through `src/llm/` (checked over their import graph). `[unit]`
- R2.3 The system shall add to the current UTC month's spend the estimated cost of each call (input tokens times USD 0.10 per million plus output tokens times USD 0.50 per million), make no call whose worst-case cost would take the spend past the cap, use as cap the lower of `capture.llm.monthly_cap_usd` and `LLM_MONTHLY_CAP_USD` when set (default USD 20), start each UTC month at zero, and log one line `llm_cap_reached` with month and cap at the first blocked call of a month. `[unit]`
- R2.4 When the service restarts, the system shall keep the month's recorded spend, and if the spend file cannot be read or parsed, then the system shall block every model call and log `llm_state_invalid` without content. `[integration]`

## R3: Ideas
As the owner, I want each Telegram idea titled and filed with my areas, types and tags, and kept
even when the model fails, so that I find it later without sorting my inbox.

- R3.1 When `POST /ideas` receives a valid body from the owner chat, the system shall make exactly one model call, store the note in the folder of the proposed type with `{area}` replaced by the proposed area, named `<title>.md` with the meeting title cleaning, with `type`, `area`, `date` (local, capture time zone), `source` (the configured text or voice value for `telegram_text` or `telegram_voice`), `source_id` (`<source value>:<chat id>:<message id>`), tags and status `classified` under the owner's property names, the text as body in NFC with LF line endings, commit, push, and answer 201 with path, commit and `classified: true`. `[integration]`
- R3.2 If an idea comes from a chat other than the configured owner chat id, then the system shall answer 200 `ignored: "unknown_chat"`, make no model call, write nothing and log the reason only; and if the body has an unknown `source`, empty text after trimming, text over 20,000 characters, a voice duration over 600 seconds, or is over 64 KiB, then the system shall answer 400 `invalid_body` or 413 `payload_too_large` without a model call. `[unit]`
- R3.3 If the model output is not valid JSON, misses a field, names an area or type outside the configured lists, has a title over 80 characters, more than 5 tags or a tag outside the tag pattern, or the call fails or is blocked by the spend guard, then the system shall store the idea in the inbox folder with the fallback type, the default idea area, no tags, status `unclassified`, and as title the first 8 words of the text cut to 80 characters, or `<untitled label> YYYY-MM-DD HH-MM` when that is empty, and answer 201 with `classified: false`. `[unit]`
- R3.4 If the `source_id` of an idea already belongs to a note, then the system shall answer 200 `already_stored: true` with that path and make no model call; if the chosen path holds another note, the system shall add ` (2)` up to ` (9)` to the title and answer 409 `note_exists` when all are taken; and no capture shall move, rename or change any existing file. `[integration]`

## R4: Emails
As the owner, I want labelled emails always kept, the rest judged by my criteria, doubtful ones
asked to me, and each kept thread readable as one note.

- R4.1 If a body to `POST /emails` has no message, more than 100 messages, a message without `text` and `html`, a date that is not ISO 8601, or is over 2 MiB, then the system shall answer 400 `invalid_body` or 413 `payload_too_large` without a model call; and if its account key is not configured, then the system shall answer 503 `config_invalid` with key path `capture.email.accounts`. `[unit]`
- R4.2 When a thread carries the account's configured label (default `2brain`) on any message or the body has `approved: true`, the system shall capture it without asking the model whether to, and otherwise make exactly one model call judged against `capture.email.criteria` that answers capture (stored), skip (200 `outcome: "skip"`, nothing written) or ask (200 `outcome: "ask"` with subject, sender and a scrubbed reason of at most 200 characters, nothing written); an invalid, failed or blocked judgment shall answer ask with an empty reason, and an invalid, failed or blocked classification of a captured thread shall store it with the subject as title, the account's default area, no tags and status `unclassified`. `[unit]`
- R4.3 When the recorded fictional thread fixtures are cleaned, the system shall produce the expected bodies byte for byte: one section per message in date order headed by sender and local date and time, the plain text part when present and otherwise HTML converted to text (paragraphs, line breaks, list items and link targets kept; scripts, styles and images dropped), quoted replies (`>` lines, "On ... wrote:" and "El ... escribió:" blocks, forwarded-original headers, Gmail and Outlook quote blocks) and signatures (`-- ` line, Gmail signature block, "Sent from my" footers) removed, no attachment or attachment name, and a body over 200,000 characters cut at the last paragraph break with the line `[2brain: truncated]`. `[integration]`
- R4.4 When a thread is captured, the system shall store one note named `YYYY-MM-DD · <title>.md` in the email type's folder for the proposed area (otherwise the account's default area), with `type`, `area`, `date` (first message, local), `source`, `source_id` (`<source value>:<account key>:<thread id>`), subject, sender, account, tags and status under the configured names, answer 201 with path and commit, and answer a later post of the same thread 200 `already_stored: true` with no model call. `[integration]`

## R5: n8n templates
As a third-party owner, I want importable Telegram and Gmail workflows, so that connecting the bot,
speech to text and each mail account is an import and a credential mapping.

- R5.1 The repository shall ship `n8n/templates/capture-telegram.json` and `n8n/templates/capture-gmail.json` that parse as n8n workflow exports, post to `http://brain:3000/ideas` and `http://brain:3000/emails` with the `2brain ingest` credential, reference the `Telegram bot`, `Speech to text` and `Gmail` credentials by name only, and contain no credential id, token, key, chat id, owner name or email outside `example.com`. `[unit]`
- R5.2 The Telegram template shall drop every update from a chat other than its owner chat id before any download, speech to text call, post or reply; post owner text with `source: "telegram_text"`; download voice notes of at most 600 seconds, transcribe them at the configured OpenAI-compatible URL (default Groq, `whisper-large-v3-turbo`, 3 tries) and post the transcript with `source: "telegram_voice"`; reply without downloading for longer voice notes and without posting for other message types or a failed or empty transcription; retry a 502 or 503 answer 3 times at least 60 seconds apart; and reply to the owner with the saved path, the inbox path when unclassified, the existing path when already stored, or the error code. `[unit]`
- R5.3 The Gmail template shall run every 30 minutes by default on threads from the last 2 days without the configured processed label (default `2brain-done`), excluding the promotions and social categories by default, post each with the account key of its settings node, add the processed label after a 200 or 201 answer, after the owner's answer to an ask, or after another 4xx answer (marking that execution failed), and retry a 502 or 503 answer 3 times at least 60 seconds apart leaving the thread unlabelled. `[unit]`
- R5.4 When the service answers `outcome: "ask"`, the Gmail template shall send the owner chat one message with subject, sender, reason and two buttons, save and discard, wait at most the configured time (default 72 hours), post the thread again with `approved: true` only on an explicit save, post nothing on discard or timeout, and post nothing and mark the execution failed for any other approval result. `[unit]`

## R6: Guide, quality and live check
As the owner, I want setup documented, the model's decisions measured, and the whole flow proven
on my accounts within budget.

- R6.1 The repository shall ship `docs/GUIDE-capture.md`, linked from docs/INSTALL.md, covering bot creation, finding the chat id, the speech to text key and provider switch, the capture and processed labels, recovering an expired ask, the criteria text, adding an account by duplicating the workflow, the spend cap and the privacy note that idea and email text goes to the Anthropic API, with no owner data (no names, domains or emails other than `example.com`). `[unit]`
- R6.2 When the capture eval runs on its datasets (at least 40 fictional ideas, 40 fictional threads with criteria and must-capture flags, and 10 injection cases), proposed area and type shall both match for at least 85% of ideas, the email outcome shall match for at least 85% of threads with no must-capture thread skipped, every output shall pass its schema or fall back, and every injection case shall end in a note with only configured values in a configured folder or in skip or ask; by default the eval replays recorded responses through the mock provider, and a live run is paid. `[eval]`
- R6.3 When the templates are imported into the owner's n8n 2.39.8, a Telegram text and a 1-minute voice note shall reach the vault, a voice note over 10 minutes shall only be answered, a labelled email and an email the criteria keep shall reach the vault, a doubtful email shall be asked on Telegram and stored after save, and after one week the Anthropic and speech to text bills shall be within the design estimate with the service spend counter within 10% of the Anthropic figure. `[manual]` (reason: needs the owner's bot, speech to text key, Gmail, n8n and billing consoles)

## Decisions closed for this spec
Approved by the owner before drafting (D1 to D7) and with the first draft (D8 to D10); design.md
lists them as RESOLVED.
- D1 One bot per install, owner chat id from the vault config; others ignored and not stored.
- D2 Voice: n8n downloads and transcribes (Groq whisper-large-v3-turbo by default, OpenAI
  possible), max 10 minutes; the service receives text only (ADR 0022).
- D3 One fixed classification call per idea; any failure stores an unclassified inbox note.
- D4 Email: label always captured; others judged against the criteria text (capture, skip, ask);
  ask is a Telegram send-and-wait approval held by n8n; one note per thread, no attachments
  (ADR 0023).
- D5 Anthropic `claude-haiku-5-5` through src/llm, structured output validated with Zod, monthly
  spend guard at USD 20 by default, persisted in `LLM_STATE_DIR`, cap also from
  `LLM_MONTHLY_CAP_USD`; the service starts without a key (ADR 0021).
- D6 Owner accepted that idea and email text goes to the Anthropic API; scrubbed first.
- D7 Routes `POST /ideas` and `POST /emails`, optional `capture` config section with its own
  setup checks.
- D8 Seen threads tracked with the Gmail processed label `2brain-done`.
- D9 `source_id` formats `<source>:<chat id>:<message id>` and `<source>:<account>:<thread id>`;
  the owner chat id is checked in n8n and again in the service.
- D10 Speech to text (Groq) joins AGENTS.md `Paid services`; thread updates are out of scope.

## Verification summary
| Tag | Count |
|---|---|
| unit | 15 |
| integration | 6 |
| e2e | 0 |
| eval | 1 |
| manual | 1 |
