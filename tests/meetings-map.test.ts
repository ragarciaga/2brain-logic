import { describe, expect, it } from "vitest";
import type { FirefliesBody, GeminiBody } from "../src/meetings/types.js";
import { mapFireflies } from "../src/sources/fireflies/map.js";
import { mapGemini } from "../src/sources/gemini/map.js";

function ff(over: Partial<FirefliesBody["transcript"]> = {}): FirefliesBody {
  return {
    source: "fireflies",
    transcript: {
      id: "ff1",
      title: "Weekly sync",
      date: 1767196800000,
      duration: 46.75,
      transcript_url: "https://app.example.com/view/ff1",
      organizer_email: "org@example.com",
      participants: ["dev@example.com"],
      meeting_attendees: [{ displayName: "Ana Ruiz", email: "ana@example.com", name: "ana" }],
      sentences: [
        { speaker_name: "Speaker 1", text: "One", start_time: 4.5 },
        { speaker_name: null, text: "Two", start_time: 31 },
      ],
      ...over,
    },
    calendar_events: [{ id: "e1", start: { date: "2026-01-01" }, end: { date: "2026-01-02" } }],
  };
}

function gm(over: Partial<GeminiBody> = {}): GeminiBody {
  return {
    source: "gemini",
    conference: {
      name: "conferenceRecords/c1",
      startTime: "2026-10-30T14:00:00.123456789Z",
      endTime: "2026-10-30T14:45:00Z",
    },
    transcript: {
      name: "conferenceRecords/c1/transcripts/t1",
      state: "FILE_GENERATED",
      docsDestination: { exportUri: "https://docs.example.com/d/1" },
    },
    participants: [
      { name: "p1", signedinUser: { displayName: "Ana Ruiz" } },
      { name: "p2", anonymousUser: { displayName: "Guest Bo" } },
      { name: "p3", phoneUser: { displayName: "Phone Cy" } },
      { name: "p4", signedinUser: {} },
    ],
    entries: [
      { participant: "p1", text: "a", startTime: "2026-10-30T14:00:05.123456789Z" },
      { participant: "p2", text: "b", startTime: "2026-10-30T14:00:10Z" },
      { participant: "p3", text: "c", startTime: "2026-10-30T14:00:20Z" },
      { participant: "p9", text: "d", startTime: "2026-10-30T14:00:30Z" },
      { participant: "p1", text: "e", startTime: "2026-10-30T13:59:00Z" },
    ],
    calendar_events: [],
    ...over,
  };
}

describe("mapFireflies (D3)", () => {
  it("maps time, segments and people", () => {
    const m = mapFireflies(ff());
    expect(m.source).toBe("fireflies");
    expect(m.sourceId).toBe("ff1");
    expect(m.start.getTime()).toBe(1767196800000);
    expect(m.end.getTime() - m.start.getTime()).toBe(2805 * 1000);
    expect(m.segments).toEqual([
      { speaker: "Speaker 1", offsetSeconds: 4.5, text: "One" },
      { speaker: "", offsetSeconds: 31, text: "Two" },
    ]);
    expect(m.people).toEqual([
      { name: "Ana Ruiz", email: "ana@example.com" },
      { email: "dev@example.com" },
    ]);
    expect(m.organizerEmail).toBe("org@example.com");
    expect(m.sourceTitle).toBe("Weekly sync");
    expect(m.sourceUrl).toBe("https://app.example.com/view/ff1");
    expect(m.calendarEvents).toHaveLength(1);
  });

  it("falls back to name when displayName is absent", () => {
    const m = mapFireflies(ff({ meeting_attendees: [{ name: "Bo Chen" }] }));
    expect(m.people[0]).toEqual({ name: "Bo Chen" });
  });

  it("keeps speaker labels as delivered, NFC and trimmed only (R2.2)", () => {
    const m = mapFireflies(
      ff({
        sentences: [
          { speaker_name: "Speaker 1", text: "a", start_time: 0 },
          { speaker_name: " Ana Ruiz ", text: "b", start_time: 1 },
          { speaker_name: "José", text: "c", start_time: 2 },
        ],
      }),
    );
    expect(m.segments.map((s) => s.speaker)).toEqual(["Speaker 1", "Ana Ruiz", "José"]);
  });

  it("omits optional keys and a non-https URL", () => {
    const m = mapFireflies(
      ff({
        transcript_url: "http://app.example.com/x",
        title: undefined,
        organizer_email: undefined,
      }),
    );
    expect("sourceUrl" in m).toBe(false);
    expect("sourceTitle" in m).toBe(false);
    expect("organizerEmail" in m).toBe(false);
  });
});

describe("mapGemini", () => {
  const labels = { unknownSpeaker: "Hablante" };

  it("names entries from signed-in, anonymous and phone users", () => {
    const m = mapGemini(gm(), labels);
    expect(m.segments.slice(0, 3).map((s) => s.speaker)).toEqual([
      "Ana Ruiz",
      "Guest Bo",
      "Phone Cy",
    ]);
  });

  it("uses the configured label for an unknown participant (R2.8)", () => {
    const m = mapGemini(gm(), labels);
    expect(m.segments[3]?.speaker).toBe("Hablante");
    expect(mapGemini(gm(), { unknownSpeaker: "Other" }).segments[3]?.speaker).toBe("Other");
  });

  it("maps ids, times, offsets and people", () => {
    const m = mapGemini(gm(), labels);
    expect(m.source).toBe("gemini");
    expect(m.sourceId).toBe("conferenceRecords/c1/transcripts/t1");
    expect(m.start.toISOString()).toBe("2026-10-30T14:00:00.123Z");
    expect(m.end.toISOString()).toBe("2026-10-30T14:45:00.000Z");
    expect(m.segments[0]?.offsetSeconds).toBe(5);
    expect(m.segments[1]?.offsetSeconds).toBeCloseTo(9.877, 3);
    expect(m.segments[4]?.offsetSeconds).toBe(0);
    expect(m.people).toEqual([{ name: "Ana Ruiz" }, { name: "Guest Bo" }, { name: "Phone Cy" }]);
    expect(m.sourceUrl).toBe("https://docs.example.com/d/1");
    expect("sourceTitle" in m).toBe(false);
  });

  it("leaves no sourceUrl for a non-https export URI", () => {
    const body = gm();
    body.transcript.docsDestination = { exportUri: "http://docs.example.com/d/1" };
    expect("sourceUrl" in mapGemini(body, labels)).toBe(false);
  });

  it("trims and NFC-normalizes display names", () => {
    const body = gm({
      participants: [{ name: "p1", signedinUser: { displayName: " José " } }],
    });
    expect(mapGemini(body, labels).segments[0]?.speaker).toBe("José");
  });
});
