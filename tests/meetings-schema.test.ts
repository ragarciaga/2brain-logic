import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import {
  GEMINI_FINISHED_STATE,
  httpsUrl,
  parseMeetingBody,
  TranscriptNotReadyError,
} from "../src/meetings/schema.js";

const MARK = "LEAKMARK";

function fireflies(over: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return {
    source: "fireflies",
    transcript: {
      id: "ff1",
      title: "Weekly sync",
      date: 1767196800000,
      duration: 46.75,
      sentences: [{ speaker_name: "Ana Ruiz", text: "Hello", start_time: 1 }],
      ...over,
    },
    calendar_events: [],
    ...extra,
  };
}

function gemini(over: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return {
    source: "gemini",
    conference: {
      name: "conferenceRecords/c1",
      startTime: "2026-10-30T14:00:00.123456789Z",
      endTime: "2026-10-30T14:45:00Z",
    },
    transcript: { name: "conferenceRecords/c1/transcripts/t1", state: GEMINI_FINISHED_STATE },
    participants: [{ name: "p1", signedinUser: { displayName: "Ana Ruiz" } }],
    entries: [{ participant: "p1", text: "Hello", startTime: "2026-10-30T14:00:05Z" }],
    calendar_events: [],
    ...over,
    ...extra,
  };
}

function rejection(input: unknown): ZodError {
  try {
    parseMeetingBody(input);
  } catch (e) {
    expect(e).toBeInstanceOf(ZodError);
    return e as ZodError;
  }
  throw new Error("expected a rejection");
}

function paths(err: ZodError): string[] {
  return err.issues.map((i) => i.path.join("."));
}

const event = (n: number) => ({
  id: `e${n}`,
  start: { date: "2026-10-30" },
  end: { date: "2026-10-31" },
});

describe("parseMeetingBody accepts", () => {
  it("a valid body of each source and strips unknown fields", () => {
    const f = parseMeetingBody(fireflies({ surprise: MARK }, { other: MARK }));
    expect(f.source).toBe("fireflies");
    expect(JSON.stringify(f)).not.toContain(MARK);
    const g = parseMeetingBody(gemini({}, { other: MARK }));
    expect(g.source).toBe("gemini");
    expect(JSON.stringify(g)).not.toContain(MARK);
  });

  it("bodies exactly at the limits", () => {
    const sentences = Array.from({ length: 50_000 }, () => ({ text: "x", start_time: 0 }));
    const people = Array.from({ length: 500 }, (_v, i) => `p${i}@example.com`);
    const events = Array.from({ length: 50 }, (_v, i) => event(i));
    expect(() =>
      parseMeetingBody(
        fireflies({ sentences, participants: people, duration: 720 }, { calendar_events: events }),
      ),
    ).not.toThrow();
    const entries = Array.from({ length: 50_000 }, () => ({
      participant: "p1",
      text: "x",
      startTime: "2026-10-30T14:00:05Z",
    }));
    expect(() =>
      parseMeetingBody(
        gemini({
          entries,
          conference: {
            name: "c",
            startTime: "2026-10-30T00:00:00Z",
            endTime: "2026-10-30T12:00:00Z",
          },
        }),
      ),
    ).not.toThrow();
  });
});

describe("parseMeetingBody rejects (R1.3)", () => {
  it("missing transcript.id", () => {
    expect(paths(rejection(fireflies({ id: undefined })))).toContain("transcript.id");
  });
  it("wrong type of transcript.date", () => {
    expect(paths(rejection(fireflies({ date: `2026${MARK}` })))).toContain("transcript.date");
  });
  it("source zoom", () => {
    expect(paths(rejection({ ...fireflies(), source: `zoom${MARK}` }))).toContain("source");
  });
  it("end not after start", () => {
    const c = { name: "c", startTime: "2026-10-30T14:00:00Z", endTime: "2026-10-30T14:00:00Z" };
    expect(paths(rejection(gemini({ conference: c })))).toContain("conference.endTime");
  });
  it("a recording longer than 12 h", () => {
    expect(paths(rejection(fireflies({ duration: 720.5 })))).toContain("transcript.duration");
    const c = { name: "c", startTime: "2026-10-30T00:00:00Z", endTime: "2026-10-30T12:00:01Z" };
    expect(paths(rejection(gemini({ conference: c })))).toContain("conference.endTime");
  });
  it("50,001 segments", () => {
    const sentences = Array.from({ length: 50_001 }, () => ({ text: "x", start_time: 0 }));
    expect(paths(rejection(fireflies({ sentences })))).toContain("transcript.sentences");
    const entries = Array.from({ length: 50_001 }, () => ({
      participant: "p1",
      text: "x",
      startTime: "2026-10-30T14:00:05Z",
    }));
    expect(paths(rejection(gemini({ entries })))).toContain("entries");
  });
  it("501 participants", () => {
    const people = Array.from({ length: 501 }, (_v, i) => `p${i}@example.com`);
    expect(paths(rejection(fireflies({ participants: people })))).toContain(
      "transcript.participants",
    );
    const att = Array.from({ length: 501 }, () => ({ name: "A" }));
    expect(paths(rejection(fireflies({ meeting_attendees: att })))).toContain(
      "transcript.meeting_attendees",
    );
    const ps = Array.from({ length: 501 }, (_v, i) => ({ name: `p${i}` }));
    expect(paths(rejection(gemini({ participants: ps })))).toContain("participants");
  });
  it("51 calendar events", () => {
    const events = Array.from({ length: 51 }, (_v, i) => event(i));
    expect(paths(rejection(fireflies({}, { calendar_events: events })))).toContain(
      "calendar_events",
    );
    expect(paths(rejection(gemini({}, { calendar_events: events })))).toContain("calendar_events");
  });
  it("a malformed Gemini timestamp", () => {
    const entries = [{ participant: "p1", text: "x", startTime: "yesterday" }];
    expect(paths(rejection(gemini({ entries })))).toContain("entries.0.startTime");
  });

  it("issues carry no received value", () => {
    const cases = [
      { ...fireflies({ date: `${MARK}` }), source: "fireflies" },
      { ...fireflies(), source: `zoom${MARK}` },
      fireflies({ id: MARK, duration: `${MARK}`, sentences: [{ text: 1, start_time: MARK }] }),
      fireflies({ title: 5, participants: [MARK, 3], transcript_url: 7 }),
      gemini({
        conference: { name: MARK, startTime: `${MARK}`, endTime: `${MARK}` },
        entries: [{ participant: MARK, text: MARK, startTime: MARK }],
      }),
      gemini({
        conference: {
          name: "c",
          startTime: "2026-10-30T14:00:00Z",
          endTime: "2026-10-30T13:00:00Z",
        },
      }),
      gemini({ participants: [{ name: MARK, signedinUser: MARK }] }),
      gemini({}, { calendar_events: [{ id: MARK, start: MARK, end: [MARK] }] }),
    ];
    for (const c of cases) {
      const err = rejection(c);
      expect(err.issues.length).toBeGreaterThan(0);
      expect(JSON.stringify(err.issues)).not.toContain(MARK);
      for (const i of err.issues) expect(Object.keys(i).sort()).not.toContain("input");
    }
  });
});

describe("unfinished Gemini transcript (D1)", () => {
  it("throws TranscriptNotReadyError for a state other than the finished one", () => {
    const body = gemini({ transcript: { name: "t", state: "STARTED" } });
    expect(() => parseMeetingBody(body)).toThrow(TranscriptNotReadyError);
    expect(() => parseMeetingBody(gemini({ transcript: { name: "t", state: "ENDED" } }))).toThrow(
      TranscriptNotReadyError,
    );
  });
  it("passes with the finished state", () => {
    expect(parseMeetingBody(gemini()).source).toBe("gemini");
  });
});

describe("httpsUrl (D2)", () => {
  it("keeps https only", () => {
    expect(httpsUrl("https://app.example.com/view/x")).toBe("https://app.example.com/view/x");
    expect(httpsUrl("http://app.example.com/x")).toBeUndefined();
    expect(httpsUrl("javascript:alert(1)")).toBeUndefined();
    expect(httpsUrl("/view/x")).toBeUndefined();
    expect(httpsUrl("")).toBeUndefined();
    expect(httpsUrl(undefined)).toBeUndefined();
  });
});

describe("no LLM imports (D4)", () => {
  function tsFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? tsFiles(p) : p.endsWith(".ts") ? [p] : [];
    });
  }
  it("src/meetings and src/sources do not import src/llm or the Anthropic SDK", () => {
    const files = [...tsFiles("src/meetings"), ...tsFiles("src/sources")];
    expect(files.length).toBeGreaterThan(3);
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      expect(text, f).not.toMatch(/from\s+["'][^"']*(\/llm\/|\/llm["']|@anthropic-ai\/sdk)/);
    }
  });
});
