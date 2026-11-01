# 0019. Meeting ingest receives source API shapes and calendar candidates from n8n

Status: accepted
Date: 2026-11-01
Related: docs/specs/05-meetings/design.md
Approved by: owner, with docs/specs/05-meetings/design.md (2026-11-01)

## Context
Meetings are named from the overlapping calendar event (ADR 0004). n8n holds the Google and
Fireflies credentials and must stay thin (ADR 0003): mapping logic in n8n nodes is untested. The
ingest API lives on the internal network and today makes no outbound call. The two sources
deliver different shapes: Fireflies GraphQL `transcript` (epoch ms start, duration in minutes,
sentences with speaker names) and the Google Meet REST API (conference record times, transcript
state, entries pointing at participants).

## Decision
We will add `POST /meetings` to the ingest app, taking a discriminated body (`source: "fireflies"`
or `"gemini"`) that carries the source's own API objects as n8n fetched them, plus the Google
Calendar events from 30 minutes before to 30 minutes after the recording. The service maps,
normalizes, picks the event and writes; it holds no Google or Fireflies credential and calls no
outside API. Redelivery of a known source id answers 200 `already_stored`.

The contract does not depend on how n8n learns of a transcript, and no Fireflies webhook is
required: on the owner's current Fireflies plan (USD 0) the template polls the Fireflies API on a
schedule within a daily request budget, and uses the "Transcription completed" webhook only where
the plan offers it. The poll's bookkeeping (posted and pending ids, the daily request count) is
the one piece of state n8n keeps, in a single Code node whose code is unit tested from the
template JSON; this is a narrow exception to ADR 0003, and no mapping moves into n8n.

## Alternatives considered
| Option | Why rejected |
|---|---|
| Service calls Calendar and Fireflies itself | Moves OAuth flows and credentials out of n8n (ADR 0003) and adds an SSRF and secrets surface |
| n8n maps to a neutral shape in Code nodes | Untested logic outside the harness (ADR 0003) |
| One route per source | Same pipeline twice; the discriminator keeps one route and one error table |
| 409 `duplicate_source` on redelivery | n8n would treat safe retries as failures |
| Require Fireflies webhooks | May need a paid Fireflies plan; the owner's plan must cost USD 0 |

## Consequences
- Positive: All mapping is unit tested with recorded fixtures; templates only fetch and forward.
- Negative: A field rename in a source API needs a service release, not just a template edit; n8n must fetch the calendar before posting; in poll mode a transcript reaches the vault up to one poll interval later, and the poll state is lost if the workflow is re-imported (repeats then answer `already_stored`).
- Revisit when: A source API changes shape often, or a source needs data that only the service can fetch.
