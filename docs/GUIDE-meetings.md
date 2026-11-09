# Meetings guide

This guide brings your recorded meetings into the vault. One n8n workflow reads Fireflies
transcripts and Google Meet transcripts (the "Notes by Gemini" documents in Drive) and posts each
meeting to the service. It runs when you ask for it from an AI client, through the
`import_meetings` tool, and once a day on its own. Each meeting becomes one note in your vault,
named from your calendar. For the install itself, see [INSTALL.md](INSTALL.md).

## Before you start

- INSTALL.md is done, including the `2brain ingest` credential, and n8n runs on the same Docker
  network as the service.
- A Fireflies account whose plan allows API access. Check its daily API request limit: one import
  uses one list request plus one request per new meeting.
- A Composio account with Google Drive and Google Calendar connected for the Google account that
  receives your meetings. The workflow reaches Google through Composio, so no Google Cloud project
  or OAuth client is needed. Check your Composio plan's monthly limit: one import uses one Drive
  search, one export per new Gemini meeting and one calendar lookup per meeting.
- For Gemini, Google Meet must take notes with Gemini and include the transcript. Gemini writes a
  document named `<title> - YYYY/MM/DD HH:MM <zone> - Notes by Gemini` and shares it with the
  invited guests of the organizer's organization.
- The template targets n8n 2.39.8, which has the `MCP Client` node.

## How an import runs

1. You ask an AI client connected to your brain, for example "bring my meetings from today". It
   calls `import_meetings` with `days` from 1 to 7 (1 when not given).
2. The service posts `{ "days": n }` to the workflow's webhook on the internal network, with your
   ingest token, and waits up to 50 seconds.
3. The workflow lists the Fireflies transcripts and the Gemini documents of the last `days` days,
   then, one meeting at a time, fetches it, reads the calendar events around it and posts it to
   `http://brain:3000/meetings`.
4. It answers with the stored paths, the paths already stored, and how many meetings were skipped
   or failed. If it takes longer than 50 seconds, the tool answers `pending: true`; the workflow
   keeps running, and `recent` shows the notes a minute later.

The `Daily sweep` trigger runs the same import with `days` 1 every night at 23:30 (n8n's time
zone), so a meeting you never asked for still reaches the vault.

The service stores only the transcript. Of a Gemini document it keeps the part after the
`<title> - Transcript` heading, never Gemini's notes. Speaker names stay as the source delivers
them: Fireflies may write `Speaker 1` when it records without joining the call, while Gemini writes
each person's name.

## Import the template

In n8n, import `n8n/templates/meetings-import.json` from the repository. If a node shows a
credential warning after the import, open it and pick the credential of that name.

## Credentials

Create these three credentials in n8n. The names must match, because the template refers to them
by name.

- `2brain ingest`: Header Auth, see INSTALL.md. The workflow uses it twice: to post meetings, and
  on its webhook, so only the service can start an import.
- `Fireflies API`: Header Auth, header name `Authorization`, value `Bearer <your Fireflies API key>`.
  Check the exact header format in the Fireflies API documentation.
- `Composio MCP`: Header Auth, header name `x-consumer-api-key`, value your Composio MCP key. That
  key reaches every account you connected in Composio; keep it only in this credential.

## Settings

Open the `Settings` node and replace the placeholders:

- `composio_mcp_url`: the MCP server address your Composio dashboard shows for MCP clients.
- `drive_account`: the Composio account id of the Google Drive connection that receives the Gemini
  documents.
- `calendar_account`: the Composio account id of the Google Calendar connection with your meetings.
- `calendar_id`: `primary`. The calendar the workflow reads to find the event of each meeting.

An AI client connected to Composio can list your account ids, or you can copy them from the
Composio dashboard.

## Connect the service

Add the workflow's webhook address to `.env` on the host, then restart the service:

```bash
echo 'MEETINGS_IMPORT_URL=http://n8n:5678/webhook/2brain-meetings-import' >> .env
docker compose up -d
```

`n8n` is the name of the n8n container on the shared Docker network. If yours differs, use the
name `docker ps` shows and the port n8n listens on. Without this variable, `import_meetings`
answers `import_not_configured`.

## Activate the workflow

Activate the workflow. Activation makes the webhook answer at its production address and the
daily schedule run. Then ask your AI client to import today's meetings, and open the workflow's
executions in n8n to see each step.

## Meetings config

The `meetings` section of `.2brain/config.yaml` in your vault controls naming, areas and skips. This
example equals the defaults of the vault template, plus one area rule:

```yaml
meetings:
  timezone: UTC
  min_minutes: 5
  untitled_label: "Untitled meeting"
  unknown_speaker_label: "Speaker"
  default_area: null
  area_rules:
    - { domain: example.com, area: work }
  sources:
    fireflies: { value: fireflies, label: "Fireflies" }
    gemini: { value: gemini, label: "Gemini" }
  properties:
    start: start
    end: end
    duration: duration_minutes
    participants: participants
    calendar_event: calendar_event
    source_title: source_title
    source_url: source_url
    versions: versions
```

- An area rule has a `domain` or a `calendar`, not both. The `area` must be one of your `areas`.
- Rules match the exact email domain of the organizer or of a participant, or the calendar id of
  the event. The first rule that matches wins.
- `default_area: null` means the first area of `areas`.
- A meeting with no matching calendar event is named `Untitled meeting HH-MM`, using the label and
  the local start time.
- When the same meeting arrives from both sources, the two notes link to each other through the
  `versions` property.

## Source allow-list

If the `sources` list of your config is not empty, add `fireflies` and `gemini`, the `value` of each
entry under `meetings.sources`. Otherwise meeting posts get a 503 `config_invalid` answer, while
other writes keep working.

## Skips and failures

- Recordings of `min_minutes` (default 5) or less get `too_short`. Transcripts with no text, and
  Gemini documents without a transcript, get `empty_transcript`. Both write nothing and count as
  skipped.
- A meeting that was already stored answers `already_stored`, so importing the same days again is
  safe. Gemini writes one document per language for some meetings; the first one imported is
  stored and the others answer `already_stored`.
- A Gemini document whose name has no date, time or known time zone is refused with 400 and counts
  as failed.
- A meeting whose calendar lookup fails is not posted and counts as failed, so it is never stored
  under a wrong name. The next import tries it again.
- A failed Fireflies list or Drive search counts as one failure; the other source still runs.

## Privacy

- The n8n execution history keeps transcripts, attendee names and emails. Limit it with the
  execution data settings of n8n.
- The webhook answers only requests that carry your ingest token.
- Composio holds the Google connections and sees the documents it exports for the workflow.
