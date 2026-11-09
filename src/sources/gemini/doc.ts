import { createHash } from "node:crypto";
import { parseGeminiDocName } from "../../meetings/gemini-doc-name.js";
import { parseRfc3339 } from "../../meetings/schema.js";
import type { GeminiDocBody, MeetingInput } from "../../meetings/types.js";
import { cleanLabel } from "../fireflies/map.js";

// Maps a "Notes by Gemini" doc, exported as plain text, to a meeting. Pure: no I/O, no config.
//
// The export holds Gemini's notes and then the transcript. Only the transcript is kept:
//
//   <title> - Transcript
//   00:00:16
//   Ana Ruiz: text
//   Bo Chen: text
//   00:05:02
//   ...
//   This editable transcript was computer generated and might contain errors. ...
//
// A `HH:MM:SS` line sets the offset of the turns after it. A `Name: text` line starts a turn.
// Any other non-empty line continues the previous turn. Nothing is reworded.

const TIMESTAMP = /^(\d{1,2}):(\d{2}):(\d{2})$/;
const TURN = /^([^:]{1,80}): (.*)$/;
const END_MARKER = "This editable transcript was computer generated";
/** Longest meeting the email date may stand for as the end (the schema's own cap). */
const MAX_SPAN_MS = 12 * 60 * 60_000;

type Segment = MeetingInput["segments"][number];

/** The transcript turns of an exported Gemini notes doc; empty when it has no transcript. */
export function transcriptSegments(text: string, title: string): Segment[] {
  const lines = text
    .replace(/^﻿/, "")
    .split(/\r\n?|\n/)
    .map((line) => line.trim());
  const heading = `${title} - Transcript`;
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i] === heading) {
      start = i;
      break;
    }
  }
  if (start === -1) {
    for (let i = lines.length - 1; i >= 0; i--) {
      if ((lines[i] ?? "").endsWith(" - Transcript")) {
        start = i;
        break;
      }
    }
  }
  if (start === -1) return [];

  const segments: Segment[] = [];
  let offset = 0;
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith(END_MARKER)) break;
    if (line === "") continue;
    const stamp = TIMESTAMP.exec(line);
    if (stamp !== null) {
      offset = Number(stamp[1]) * 3600 + Number(stamp[2]) * 60 + Number(stamp[3]);
      continue;
    }
    const turn = TURN.exec(line);
    if (turn !== null && cleanLabel(turn[1] ?? "") !== "") {
      segments.push({
        speaker: cleanLabel(turn[1] ?? ""),
        offsetSeconds: offset,
        text: turn[2] ?? "",
      });
      continue;
    }
    const last = segments[segments.length - 1];
    if (last === undefined) segments.push({ speaker: "", offsetSeconds: offset, text: line });
    else last.text = `${last.text}\n${line}`;
  }
  return segments;
}

/**
 * Source id from the title and start, so the two language docs Gemini writes for one meeting
 * dedupe: the first one posted is stored, the other answers `already_stored`.
 */
export function geminiDocSourceId(title: string, start: Date): string {
  const digest = createHash("sha256").update(`${title}\n${start.toISOString()}`).digest("hex");
  return `doc-${digest.slice(0, 24)}`;
}

export function mapGeminiDoc(body: GeminiDocBody): MeetingInput {
  const name = parseGeminiDocName(body.doc.name);
  // The schema refuses any other name; this guard only keeps the types honest.
  if (name === undefined) throw new Error("not a Gemini notes document name");
  const segments = transcriptSegments(body.doc.text, name.title);
  const startMs = name.start.getTime();

  const lastOffset = segments.reduce((max, s) => Math.max(max, s.offsetSeconds), 0);
  let endMs = startMs + Math.max(lastOffset, 60) * 1000;
  const createdMs = body.created_time === undefined ? undefined : parseRfc3339(body.created_time);
  if (createdMs !== undefined && createdMs > endMs && createdMs - startMs <= MAX_SPAN_MS)
    endMs = createdMs;

  const people: MeetingInput["people"] = [];
  const seen = new Set<string>();
  for (const s of segments) {
    const key = s.speaker.toLowerCase();
    if (s.speaker === "" || seen.has(key)) continue;
    seen.add(key);
    people.push({ name: s.speaker });
  }

  return {
    source: "gemini",
    sourceId: geminiDocSourceId(name.title, name.start),
    start: name.start,
    end: new Date(endMs),
    sourceTitle: name.title,
    sourceUrl: `https://docs.google.com/document/d/${encodeURIComponent(body.doc.id)}/edit`,
    people,
    segments,
    calendarEvents: body.calendar_events,
  };
}
