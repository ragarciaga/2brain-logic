import { httpsUrl, parseRfc3339 } from "../../meetings/schema.js";
import type { GeminiBody, MeetingInput } from "../../meetings/types.js";
import { cleanLabel } from "../fireflies/map.js";

export function mapGemini(body: GeminiBody, labels: { unknownSpeaker: string }): MeetingInput {
  const names = new Map<string, string>();
  for (const p of body.participants) {
    const display =
      p.signedinUser?.displayName ?? p.anonymousUser?.displayName ?? p.phoneUser?.displayName ?? "";
    names.set(p.name, cleanLabel(display));
  }
  const startMs = parseRfc3339(body.conference.startTime) ?? 0;
  const endMs = parseRfc3339(body.conference.endTime) ?? 0;

  const people: MeetingInput["people"] = [];
  for (const display of names.values()) if (display !== "") people.push({ name: display });

  const input: MeetingInput = {
    source: "gemini",
    sourceId: body.transcript.name,
    start: new Date(startMs),
    end: new Date(endMs),
    people,
    segments: body.entries.map((e) => {
      const known = names.get(e.participant);
      const at = parseRfc3339(e.startTime) ?? startMs;
      return {
        speaker: known === undefined ? labels.unknownSpeaker : known,
        offsetSeconds: Math.max(0, (at - startMs) / 1000),
        text: e.text,
      };
    }),
    calendarEvents: body.calendar_events,
  };
  const url = httpsUrl(body.transcript.docsDestination?.exportUri);
  if (url !== undefined) input.sourceUrl = url;
  return input;
}
