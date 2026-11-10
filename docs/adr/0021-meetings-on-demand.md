# 0021. Meetings are imported on demand through one n8n workflow; Gemini from the notes doc

Status: accepted
Date: 2026-11-09
Related: docs/adr/0019-meeting-ingest-contract.md, docs/GUIDE-meetings.md, issue #255
Approved by: owner, in conversation (2026-11-09)

## Context

F5 shipped two n8n templates that poll Fireflies and the Google Meet REST API every hour. On the
reference install the owner analyzes every meeting in an AI client anyway, the Meet REST API needs
a Google Cloud project and OAuth client the owner does not want, and Google access already exists
through Composio, whose free plan caps the calls to Composio-managed apps at 20,000 a month for
all of the owner's use. Gemini's "Notes by Gemini" document, exported as text, holds the full
transcript with real speaker names.

## Decision

- One n8n workflow, `meetings-import.json`, imports the meetings of the last 1 to 7 days. It
  starts from a webhook that only the service calls, and from a daily schedule with 1 day.
- The service exposes the MCP tool `import_meetings`. It posts `{ days }` to
  `MEETINGS_IMPORT_URL` with the ingest token, waits up to 50 s and returns the stored paths and
  counts. It never takes the writer queue, because n8n's posts need it.
- Gemini meetings come from the notes documents in Drive (`GOOGLEDRIVE_FIND_FILE`, then
  `GOOGLEDRIVE_EXPORT_GOOGLE_WORKSPACE_FILE` as text), and the calendar lookup of both sources goes
  through Composio, called from n8n's `MCP Client` node. Fireflies keeps its own API key.
- `POST /meetings` gains the `gemini_doc` shape: the doc id, name and exported text. The service
  dates the meeting from the doc name, keeps only the transcript section and stores it under the
  `gemini` source value, so naming, areas, versions and dedupe are unchanged. The source id comes
  from the title and start, so the language copies of one meeting dedupe.
- The Fireflies poll state, daily budget and webhook mode, and the Meet REST API template, are
  removed.

## Alternatives considered

| Option                                                      | Why rejected                                                                                                                 |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Keep hourly polling                                         | About 700 Composio calls a month for nothing on the days the owner asks for no meeting                                       |
| On demand only, no daily sweep                              | A meeting nobody asks for never reaches the vault, and its Gemini doc belongs to the organizer, who can delete it            |
| Claude fetches the transcript and saves it with `save_note` | A model retyping a one hour transcript truncates or changes it; transcripts must be stored verbatim                          |
| Read the "Notes by Gemini" email                            | The email does not carry the doc id in its preview; a Drive search finds the doc, its name and its creation time in one call |
| Google OAuth credentials in n8n                             | Needs a Google Cloud project; a Workspace may block the unverified app                                                       |

## Consequences

- Positive: Composio use drops to a few hundred calls a month; no Google Cloud project; Gemini notes
  carry real speaker names; one template instead of two.
- Negative: The Composio MCP key in n8n reaches every account connected in Composio. A doc name in
  an unknown time zone is refused until the zone is added. If the Composio cap is reached, imports
  fail until the month resets.
- Revisit when: Composio changes its MCP or plan limits, or Gemini changes the doc name or export
  layout.
