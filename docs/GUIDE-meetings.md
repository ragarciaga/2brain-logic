# Meetings guide

This guide connects your meeting sources to the vault. Two n8n workflows read meetings and post
them to the ingest API: one for Fireflies and one for Google Meet transcripts (Gemini notes). Each
meeting becomes one note in your vault. For the install itself, see [INSTALL.md](INSTALL.md).

## Before you start

- INSTALL.md is done, including the `2brain ingest` credential, and n8n runs on the same Docker
  network as the service.
- Check your Fireflies plan's daily API request limit, and whether the plan offers webhooks. The
  defaults in this guide assume a limit of about 50 requests a day. If your limit is lower, change
  the budget as described below.
- For Google Meet, your Workspace edition must produce Meet transcripts.
- The templates target n8n 2.39.8.

## Import the templates

In n8n, import both files from the `n8n/templates/` folder of the repository:

- `meetings-fireflies.json`
- `meetings-gemini.json`

Both post to `http://brain:3000/meetings`. If a node shows a credential warning after the import,
open it and pick the credential of that name.

## Credentials

Create these four credentials in n8n. The names must match, because the templates refer to them by
name.

- `2brain ingest`: Header Auth, see INSTALL.md.
- `Fireflies API`: Header Auth, header name `Authorization`, value `Bearer <your Fireflies API key>`.
  Check the exact header format in the Fireflies API documentation.
- `Google Calendar`: Google Calendar OAuth2 API. The templates only read events, with GET
  requests. If the credential lets you choose scopes, use
  `https://www.googleapis.com/auth/calendar.readonly`.
- `Google Meet`: Google OAuth2 API, scope `https://www.googleapis.com/auth/meetings.space.readonly`.

Both workflows have a `Settings` node. Open it to change these values:

- `calendar_id`: `primary`. The calendar the workflow reads to find the event of each meeting.

The Fireflies workflow has two more values, described in the next sections.

## Fireflies: poll or webhook mode

The Fireflies workflow ships in poll mode: `Poll schedule` is on and `Fireflies webhook` is
disabled. Poll mode needs only an API key, so it should work on any plan that allows API access.
Use webhook mode only if your plan offers webhooks.

Run one mode only. The executions of a workflow share its static data without locking, so two
triggers at once can overwrite each other's state.

## Fireflies: poll interval and daily budget

The `Settings` node of the Fireflies workflow has two values:

- `poll_interval_minutes`: `60`
- `daily_budget`: `40`

The schedule does not read `poll_interval_minutes`. To change the interval, edit the
`Poll schedule` trigger and set `poll_interval_minutes` in `Settings` to the same value, so that
the two agree.

Every request to Fireflies counts against `daily_budget`, retries included, per UTC day. One list
request runs per poll, and one fetch runs per new transcript (up to 3 tries each).

- `1440/interval` list requests a day: 24 at the default interval.
- `daily_budget - 24` is what is left for fetches: 16 at the defaults.

Keep `daily_budget` below your plan's daily API request limit. If you have more meetings than the
fetches left, lengthen the interval: at 120 minutes there are 12 list requests, which leaves 28
fetches.

When the budget is used up, the listed ids stay pending until the next UTC day.

During an ingest outage one execution can take about 3 minutes per meeting and overlap the next
poll. Keep the interval at 60 minutes or more, and keep the budget modest.

## Fireflies webhook mode

In this order:

1. Replace the path `REPLACE-WITH-RANDOM-PATH` in the `Fireflies webhook` node with a long random
   value. This is required: the placeholder is public, and anyone who knows the URL can call it.
2. Disable `Poll schedule` and enable `Fireflies webhook`.
3. In Fireflies, enter the Production URL of the `Fireflies webhook` node.
4. Only the `Transcription completed` event is used. The webhook path goes through `Settings`, so
   it uses `calendar_id` and `daily_budget` too.
5. Nothing is kept pending in webhook mode. If the daily budget is reached, Fireflies answers a
   rate-limit error, or ingest still answers 502 or 503 after the last post, the execution ends
   without an error and the meeting is not fetched again. A fetch or calendar failure fails the
   execution.
6. Recovery: within 24 hours, switch to poll mode for one poll. It fetches the meetings of the last
   24 hours that were not posted.

## Activate the workflows

Activate both workflows instead of running them by hand. Activation is what makes the schedules
run.

The Fireflies workflow keeps its state (posted and pending ids, and the daily count) in n8n static
data, which n8n keeps only for active workflows. Check this in the n8n documentation for your
version. Do not import that workflow again over a running one. Re-importing loses the state, and
repeated meetings then answer `already_stored` and still use budget.

The Gemini workflow keeps no state. Each poll posts every conference record of the last 24 hours
again, and the repeats answer `already_stored`.

## Google Meet: Workspace edition and Meet REST API

1. Confirm with your admin, or in Google's edition comparison, that your Workspace edition produces
   Meet transcripts and that transcripts are turned on.
2. In a Google Cloud project, enable the Google Meet REST API and create the OAuth client that the
   two Google credentials use.
3. The Gemini workflow polls every 60 minutes for conference records that ended in the last 24
   hours. If you change its interval, keep it well under 24 hours, or meetings fall out of the
   window.

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
- A `calendar` rule compares against the `calendar_id` of the `Settings` node of the workflow, so
  the value is the same for every meeting that workflow posts. Prefer `domain` rules.
- `default_area: null` means the first area of `areas`.
- A meeting with no matching calendar event is named `Untitled meeting HH-MM`, using the label and
  the local start time.

## Source allow-list

If the `sources` list of your config is not empty, add `fireflies` and `gemini`, the `value` of each
entry under `meetings.sources`. Otherwise meeting posts get a 503 `config_invalid` answer, while
other writes keep working. A 503 looks like an ingest outage, so check this first when only
meetings fail. An empty `sources` list needs no change.

## Skips and retries

- Recordings of `min_minutes` (default 5) or less get `too_short`. Transcripts with no text get
  `empty_transcript`. Both answer 200, write nothing and count as posted.
- A meeting that was already stored answers `already_stored`.
- Answers 502 and 503 are posted again 3 times, 60 seconds apart, so 4 posts in all. After that the
  Fireflies poll keeps the id pending, and the Gemini workflow posts it again on a later poll while
  the record is inside the 24 hour window.
- A 4xx answer fails the execution at `Ingest refused`. The Fireflies workflow records the id as
  posted and does not fetch it again: it stays recorded for 48 hours, which is longer than its 24
  hour list window, and the webhook is not sent twice. To recover that meeting, fix the cause and
  add the meeting to the vault by hand. The Gemini workflow repeats the failure on every poll for 24
  hours.
- A meeting whose source id holds a secret is refused with 400 and is not stored. Add that meeting
  to the vault by hand.
- Only the transcript fetch and the calendar calls of Fireflies, and the Meet and calendar calls of
  Gemini, get 3 tries, 5 seconds apart, then the execution ends at
  `Source or calendar failed` (Fireflies) or `Meet or calendar failed` (Gemini). The Fireflies poll
  keeps the id pending.
- A failed Fireflies list request (`List transcripts`) is not retried. The execution fails at
  `Source or calendar failed` and makes no other Fireflies request; pending ids wait for the next
  poll. A wrong API key shows up as failed executions: open the output of `List transcripts`. A
  rate-limit answer is not a failure (next bullet).
- A rate-limit error stops the Fireflies requests of that execution. The ids stay pending.
- The Gemini workflow posts only transcripts in the state `FILE_GENERATED`.

## Privacy

- The n8n execution history keeps transcripts, attendee names and emails. Limit it with the
  execution data settings of n8n.
- Anyone who knows the webhook URL can send any meeting id, and n8n fetches it with your key. A team
  key includes the meetings of your teammates. Keep the path secret, and prefer a personal key.
