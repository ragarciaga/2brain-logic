# 0022. Voice notes are transcribed in n8n, with Groq by default

Status: proposed
Date: 2026-11-01
Related: docs/specs/06-capture/design.md, docs/adr/0003-thin-n8n.md
Approved by: pending, with docs/specs/06-capture/design.md

## Context
Telegram voice notes must become text before they are classified (brief, DEFERRED speech-to-text
choice). Telegram delivers only a file id; fetching the audio needs the bot token, which lives in
n8n. Audio of 10 minutes is a few megabytes, while the ingest API takes JSON bodies of at most
4 MiB and has no file handling. Hosted Whisper models expose an OpenAI-compatible
`/audio/transcriptions` endpoint: Groq serves `whisper-large-v3-turbo` at about USD 0.04 per
audio hour, OpenAI serves its own models at a higher price. Expected use is about 10 audio hours a
month.

## Decision
We will transcribe in n8n: the Telegram template downloads the voice file with the bot
credential, posts it to the transcription URL in its `Settings` node (default Groq,
`whisper-large-v3-turbo`) with the `Speech to text` credential, and posts only the transcript to
`POST /ideas` with `source: "telegram_voice"`. Voice notes longer than 10 minutes are answered
with a message and never downloaded. Switching to OpenAI is a change of URL, model and credential
in n8n; the service does not change.

## Alternatives considered
| Option | Why rejected |
|---|---|
| Transcribe in the service | Audio crosses the internal API, needs multipart bodies and a second provider key in the service |
| Local Whisper in the container | Does not fit the 512 MB memory limit or the host's spare CPU |
| OpenAI as default | Several times the price of Groq for the same model family at this volume |
| n8n AI transcription nodes | Tie the template to one provider's node; the HTTP node keeps the provider a setting |

## Consequences
- Positive: The service stays text only and holds no audio or speech to text key; the provider is
  swappable without a release.
- Negative: The transcription step is n8n logic, tested only from the template JSON and by hand;
  audio leaves the host to the provider; a second paid service to track (under USD 1 a month).
- Revisit when: Transcription quality in the owner's language is poor, the provider changes
  price or terms, or voice volume grows past a few hours a day.
