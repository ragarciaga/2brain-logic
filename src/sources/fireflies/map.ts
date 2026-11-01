import { httpsUrl } from "../../meetings/schema.js";
import type { FirefliesBody, MeetingInput } from "../../meetings/types.js";

/** Speaker labels arrive as delivered: NFC-normalized and trimmed only (R2.2). */
export function cleanLabel(s: string): string {
  return s.normalize("NFC").trim();
}

export function mapFireflies(body: FirefliesBody): MeetingInput {
  const t = body.transcript;
  const people: MeetingInput["people"] = [];
  for (const a of t.meeting_attendees ?? []) {
    const person: { name?: string; email?: string } = {};
    const name = a.displayName ?? a.name;
    if (name !== undefined) person.name = name;
    if (a.email !== undefined) person.email = a.email;
    people.push(person);
  }
  for (const email of t.participants ?? []) people.push({ email });

  const input: MeetingInput = {
    source: "fireflies",
    sourceId: t.id,
    start: new Date(t.date),
    end: new Date(t.date + t.duration * 60_000),
    people,
    segments: t.sentences.map((s) => ({
      speaker: cleanLabel(s.speaker_name ?? ""),
      offsetSeconds: s.start_time,
      text: s.text,
    })),
    calendarEvents: body.calendar_events,
  };
  if (t.title !== undefined) input.sourceTitle = t.title;
  const url = httpsUrl(t.transcript_url);
  if (url !== undefined) input.sourceUrl = url;
  if (t.organizer_email !== undefined) input.organizerEmail = t.organizer_email;
  return input;
}
