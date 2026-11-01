import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import {
  GEMINI_FINISHED_STATE,
  httpsUrl,
  parseMeetingBody,
  secretSourceIdIssue,
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

describe("string field caps (1000 characters)", () => {
  const ok = "x".repeat(1000);
  const over = "x".repeat(1001);
  const cal = (over_: Record<string, unknown>) => ({
    calendar_events: [{ ...event(1), ...over_ }],
  });
  const ffPeople = (name: string) => ({
    meeting_attendees: [{ displayName: name, email: name, name }],
  });
  const cases: Array<[string, (v: string) => unknown, string]> = [
    ["fireflies transcript.id", (v) => fireflies({ id: v }), "transcript.id"],
    ["fireflies transcript.title", (v) => fireflies({ title: v }), "transcript.title"],
    [
      "fireflies transcript_url",
      (v) => fireflies({ transcript_url: v }),
      "transcript.transcript_url",
    ],
    [
      "fireflies organizer_email",
      (v) => fireflies({ organizer_email: v }),
      "transcript.organizer_email",
    ],
    [
      "fireflies participants",
      (v) => fireflies({ participants: [v] }),
      "transcript.participants.0",
    ],
    [
      "fireflies attendee email",
      (v) => fireflies(ffPeople(v)),
      "transcript.meeting_attendees.0.email",
    ],
    ["calendar event id", (v) => fireflies({}, cal({ id: v })), "calendar_events.0.id"],
    ["calendar event title", (v) => fireflies({}, cal({ title: v })), "calendar_events.0.title"],
    [
      "gemini conference.name",
      (v) =>
        gemini({
          conference: {
            name: v,
            startTime: "2026-10-30T14:00:00Z",
            endTime: "2026-10-30T14:45:00Z",
          },
        }),
      "conference.name",
    ],
    [
      "gemini transcript.name",
      (v) => gemini({ transcript: { name: v, state: GEMINI_FINISHED_STATE } }),
      "transcript.name",
    ],
    [
      "gemini exportUri",
      (v) =>
        gemini({
          transcript: {
            name: "t",
            state: GEMINI_FINISHED_STATE,
            docsDestination: { exportUri: v },
          },
        }),
      "transcript.docsDestination.exportUri",
    ],
    [
      "gemini participant name",
      (v) => gemini({ participants: [{ name: v }] }),
      "participants.0.name",
    ],
    [
      "gemini participant displayName",
      (v) => gemini({ participants: [{ name: "p1", signedinUser: { displayName: v } }] }),
      "participants.0.signedinUser.displayName",
    ],
  ];
  it.each(cases)("%s: 1000 passes, 1001 is rejected", (_name, build, path) => {
    expect(() => parseMeetingBody(build(ok))).not.toThrow();
    expect(paths(rejection(build(over)))).toContain(path);
  });
});

describe("secretSourceIdIssue (R8.7)", () => {
  const ghToken = ["gh", "p_", "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6"].join("");
  const card = ["4111", "1111", "1111", "1111"].join("");
  const oauthSecret = ["GOC", "SPX-", "Ab1Cd2Ef3Gh4Ij5Kl6Mn7O", "p8Qr9S"].join("");

  it("names transcript.id for a Fireflies id holding a token or a card number", () => {
    for (const id of [ghToken, card]) {
      const issue = secretSourceIdIssue(parseMeetingBody(fireflies({ id })));
      expect(issue?.path).toBe("transcript.id");
    }
  });
  it("names transcript.name for a Gemini name holding a client secret", () => {
    const name = `conferenceRecords/c1/transcripts/${oauthSecret}`;
    const body = gemini({ transcript: { name, state: GEMINI_FINISHED_STATE } });
    expect(secretSourceIdIssue(parseMeetingBody(body))?.path).toBe("transcript.name");
  });
  it("gives undefined for ordinary ids", () => {
    expect(secretSourceIdIssue(parseMeetingBody(fireflies()))).toBeUndefined();
    expect(secretSourceIdIssue(parseMeetingBody(gemini()))).toBeUndefined();
  });
  it("the message holds no part of the value", () => {
    const issue = secretSourceIdIssue(parseMeetingBody(fireflies({ id: ghToken })));
    const text = JSON.stringify(issue);
    expect(text).not.toContain("ghp_");
    expect(text).not.toContain(ghToken.slice(-8));
    expect(text).not.toContain("github");
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
