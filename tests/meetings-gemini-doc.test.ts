import { describe, expect, it, vi } from "vitest";
import { parseGeminiDocName } from "../src/meetings/gemini-doc-name.js";
import type { MeetingInput, MeetingOk } from "../src/meetings/types.js";
import { createApp } from "../src/server/app.js";
import { geminiDocSourceId, mapGeminiDoc, transcriptSegments } from "../src/sources/gemini/doc.js";
import type { NoteWriter } from "../src/vault/write-note.js";

// Fictional meeting. The layout copies a real "Notes by Gemini" text export: notes first, then
// the transcript heading, timestamp lines, `Name: text` turns and the closing notice.
const TITLE = "Pilot review - Ana / Bo";
const NAME = `${TITLE} - 2026/11/09 12:59 CET - Notes by Gemini`;
const TEXT = [
  "﻿Please rate the new Quick notes tab by taking a short survey.",
  TITLE,
  "",
  "Summary",
  "Ana Ruiz and Bo Chen reviewed the pilot. Next steps: Bo sends the numbers.",
  "Details",
  "Numbers: Ana Ruiz asked for the pilot numbers.",
  "",
  "Nov 9, 2026",
  `${TITLE} - Transcript`,
  "00:00:16",
  "",
  "Ana Ruiz: Let us start with the numbers. ",
  "Bo Chen: Sure.",
  "The pilot closed at 120 users.",
  "00:05:02",
  "Ana Ruiz: Good: send me the sheet.",
  "Bo Chen: Will do.",
  "Transcription ended after 00:06:10",
  "",
  "This editable transcript was computer generated and might contain errors. People can also change the text after it was created.",
].join("\r\n");

const body = (over: Record<string, unknown> = {}) => ({
  source: "gemini_doc",
  doc: { id: "1AbCdEfGhIjKlMnOp", name: NAME, text: TEXT },
  created_time: "2026-11-09T12:43:49Z",
  calendar_events: [],
  ...over,
});

describe("parseGeminiDocName", () => {
  it("reads title, start in UTC and the language suffix", () => {
    expect(parseGeminiDocName(NAME)).toEqual({
      title: TITLE,
      start: new Date("2026-11-09T11:59:00Z"),
    });
    expect(parseGeminiDocName(`Sync - 2026/11/03 16:00 CET - Notes by Gemini (Spanish)`)).toEqual({
      title: "Sync",
      start: new Date("2026-11-03T15:00:00Z"),
      language: "Spanish",
    });
  });

  it("accepts numeric GMT offsets", () => {
    expect(
      parseGeminiDocName("Sync - 2026/11/03 07:30 GMT-05:00 - Notes by Gemini")?.start,
    ).toEqual(new Date("2026-11-03T12:30:00Z"));
    expect(parseGeminiDocName("Sync - 2026/11/03 07:30 GMT+1 - Notes by Gemini")?.start).toEqual(
      new Date("2026-11-03T06:30:00Z"),
    );
  });

  it("refuses unknown zones, impossible dates and other names", () => {
    expect(parseGeminiDocName("Sync - 2026/11/03 16:00 XYZ - Notes by Gemini")).toBeUndefined();
    expect(parseGeminiDocName("Sync - 2026/02/31 16:00 CET - Notes by Gemini")).toBeUndefined();
    expect(parseGeminiDocName("Sync - 2026/11/03 24:00 CET - Notes by Gemini")).toBeUndefined();
    expect(parseGeminiDocName("Quarterly plan")).toBeUndefined();
  });
});

describe("transcriptSegments", () => {
  it("keeps only the transcript, with offsets and continuation lines, words unchanged", () => {
    expect(transcriptSegments(TEXT, TITLE)).toEqual([
      { speaker: "Ana Ruiz", offsetSeconds: 16, text: "Let us start with the numbers." },
      { speaker: "Bo Chen", offsetSeconds: 16, text: "Sure.\nThe pilot closed at 120 users." },
      { speaker: "Ana Ruiz", offsetSeconds: 302, text: "Good: send me the sheet." },
      { speaker: "Bo Chen", offsetSeconds: 302, text: "Will do." },
    ]);
  });

  it("never takes the notes: a doc without a transcript gives no segments", () => {
    const notesOnly = TEXT.split(`${TITLE} - Transcript`)[0] ?? "";
    expect(transcriptSegments(notesOnly, TITLE)).toEqual([]);
  });

  it("finds the heading when the doc title differs from the name", () => {
    const renamed = TEXT.replace(`${TITLE} - Transcript`, "Pilot review (renamed) - Transcript");
    expect(transcriptSegments(renamed, TITLE)).toHaveLength(4);
  });
});

describe("mapGeminiDoc", () => {
  it("maps to a gemini meeting with start from the name and end from the doc creation time", () => {
    const m = mapGeminiDoc(body() as never);
    expect(m.source).toBe("gemini");
    expect(m.start).toEqual(new Date("2026-11-09T11:59:00Z"));
    expect(m.end).toEqual(new Date("2026-11-09T12:43:49Z"));
    expect(m.sourceTitle).toBe(TITLE);
    expect(m.sourceUrl).toBe("https://docs.google.com/document/d/1AbCdEfGhIjKlMnOp/edit");
    expect(m.people).toEqual([{ name: "Ana Ruiz" }, { name: "Bo Chen" }]);
    expect(m.segments).toHaveLength(4);
  });

  it("falls back to the last timestamp when the creation time is missing or implausible", () => {
    const start = new Date("2026-11-09T11:59:00Z").getTime();
    expect(mapGeminiDoc(body({ created_time: undefined }) as never).end.getTime()).toBe(
      start + 302_000,
    );
    expect(
      mapGeminiDoc(body({ created_time: "2026-11-12T12:00:00Z" }) as never).end.getTime(),
    ).toBe(start + 302_000);
  });

  it("gives the two language docs of one meeting the same source id", () => {
    const spanish = mapGeminiDoc(
      body({ doc: { id: "other", name: `${NAME} (Spanish)`, text: TEXT } }) as never,
    );
    expect(spanish.sourceId).toBe(mapGeminiDoc(body() as never).sourceId);
    expect(spanish.sourceId).toBe(geminiDocSourceId(TITLE, new Date("2026-11-09T11:59:00Z")));
  });
});

describe("POST /meetings with a gemini_doc body", () => {
  const TOKEN = ["fictional", "doc", "token", "0123456789", "abcdefghijk"].join("-");
  function setup() {
    const writeMeeting = vi.fn(
      async (_input: MeetingInput): Promise<MeetingOk> => ({
        ok: true,
        path: "m.md",
        commit: "c1",
      }),
    );
    const app = createApp({
      writer: {} as NoteWriter,
      meetings: { writeMeeting },
      ingestToken: TOKEN,
    });
    const send = (payload: unknown) =>
      app.request("/meetings", {
        method: "POST",
        body: JSON.stringify(payload),
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      });
    return { writeMeeting, send };
  }

  it("stores the mapped meeting", async () => {
    const { writeMeeting, send } = setup();
    const res = await send(body());
    expect(res.status).toBe(201);
    expect(writeMeeting.mock.calls[0]?.[0].segments).toHaveLength(4);
  });

  it("answers 400 for a name it cannot date, without writing", async () => {
    const { writeMeeting, send } = setup();
    const res = await send(body({ doc: { id: "x", name: "Quarterly plan", text: TEXT } }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { issues: { path: string }[] }).issues[0]?.path).toBe("doc.name");
    expect(writeMeeting).not.toHaveBeenCalled();
  });
});
