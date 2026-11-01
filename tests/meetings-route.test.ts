import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigInvalidError } from "../src/config/vault-config.js";
import * as schema from "../src/meetings/schema.js";
import type { MeetingInput, MeetingOk } from "../src/meetings/types.js";
import { createApp } from "../src/server/app.js";
import type { NoteWriter } from "../src/vault/write-note.js";

vi.mock("../src/meetings/schema.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/meetings/schema.js")>();
  return { ...real, parseMeetingBody: vi.fn(real.parseMeetingBody) };
});

// 32+ characters, built from parts so no secret-shaped literal sits in the file.
const TOKEN = ["fictional", "meetings", "token", "0123456789", "abcdefghijk"].join("-");
const AUTH = { authorization: `Bearer ${TOKEN}` };
const JSON_TYPE = { "content-type": "application/json" };
const MARK = "LEAKMARK";
const MiB = 1024 * 1024;

const stored: MeetingOk = { ok: true, path: "meetings/2026/a.md", commit: "abc123" };

function setup(result: MeetingOk | Error = stored) {
  const writeMeeting = vi.fn(async (_input: MeetingInput): Promise<MeetingOk> => {
    if (result instanceof Error) throw result;
    return result;
  });
  const notes = {} as NoteWriter;
  const logs: string[] = [];
  const app = createApp({
    writer: notes,
    meetings: { writeMeeting },
    ingestToken: TOKEN,
    log: (m) => logs.push(m),
  });
  return { app, writeMeeting, logs };
}

function send(
  app: ReturnType<typeof setup>["app"],
  body: string | Uint8Array,
  headers: Record<string, string> = { ...AUTH, ...JSON_TYPE },
) {
  return app.request("/meetings", { method: "POST", body, headers });
}

const fireflies = () => ({
  source: "fireflies",
  transcript: {
    id: "ff1",
    title: "Weekly sync",
    date: 1767196800000,
    duration: 45,
    organizer_email: "ana@example.com",
    sentences: [{ speaker_name: "Ana Ruiz", text: "Hello", start_time: 1 }],
  },
  calendar_events: [],
});

const gemini = (state = schema.GEMINI_FINISHED_STATE) => ({
  source: "gemini",
  conference: {
    name: "conferenceRecords/c1",
    startTime: "2026-10-30T14:00:00Z",
    endTime: "2026-10-30T14:45:00Z",
  },
  transcript: { name: "conferenceRecords/c1/transcripts/t1", state },
  participants: [{ name: "p1", signedinUser: { displayName: "Ana Ruiz" } }],
  entries: [
    { participant: "unknown-participant", text: "Hello", startTime: "2026-10-30T14:00:05Z" },
  ],
  calendar_events: [],
});

beforeEach(() => {
  vi.mocked(schema.parseMeetingBody).mockClear();
});

describe("POST /meetings auth", () => {
  it("R1.2: no token and a wrong token give 401 and no writer call", async () => {
    const { app, writeMeeting } = setup();
    const body = JSON.stringify(fireflies());
    for (const headers of [JSON_TYPE, { ...JSON_TYPE, authorization: "Bearer wrong" }]) {
      const response = await send(app, body, headers);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ ok: false, error: "unauthorized" });
    }
    expect(writeMeeting).not.toHaveBeenCalled();
    expect(schema.parseMeetingBody).not.toHaveBeenCalled();
  });

  it("is 404 behind the token when no meeting writer is given", async () => {
    const app = createApp({ writer: {} as NoteWriter, ingestToken: TOKEN });
    expect((await send(app, "{}")).status).toBe(404);
  });
});

describe("POST /meetings size", () => {
  it("R1.4: 4 MiB + 1 byte is 413 and never parsed or written", async () => {
    const { app, writeMeeting } = setup();
    const response = await send(app, new Uint8Array(4 * MiB + 1));
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ ok: false, error: "payload_too_large" });
    expect(schema.parseMeetingBody).not.toHaveBeenCalled();
    expect(writeMeeting).not.toHaveBeenCalled();
  });

  it("R1.4: a valid body of exactly 4 MiB is accepted", async () => {
    const { app, writeMeeting } = setup();
    const json = JSON.stringify(fireflies());
    const padded = json + " ".repeat(4 * MiB - json.length);
    expect(padded.length).toBe(4 * MiB);
    const response = await send(app, padded);
    expect(response.status).toBe(201);
    expect(writeMeeting).toHaveBeenCalledTimes(1);
  });

  it("a 401 comes before the 413", async () => {
    const { app } = setup();
    const response = await send(app, new Uint8Array(4 * MiB + 1), JSON_TYPE);
    expect(response.status).toBe(401);
  });
});

describe("POST /meetings media type and JSON", () => {
  it("R1.5: text/plain is 415", async () => {
    const { app, writeMeeting } = setup();
    const response = await send(app, JSON.stringify(fireflies()), {
      ...AUTH,
      "content-type": "text/plain",
    });
    expect(response.status).toBe(415);
    expect(await response.json()).toEqual({ ok: false, error: "unsupported_media_type" });
    expect(writeMeeting).not.toHaveBeenCalled();
  });

  it("R1.5: a missing content-type is 415", async () => {
    const { app } = setup();
    const response = await app.request("/meetings", {
      method: "POST",
      body: new TextEncoder().encode(JSON.stringify(fireflies())),
      headers: { ...AUTH },
    });
    expect(response.status).toBe(415);
  });

  it("R1.5: malformed JSON is 400 invalid_json", async () => {
    const { app } = setup();
    const response = await send(app, "{");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: "invalid_json" });
  });
});

describe("POST /meetings validation", () => {
  it("D1: a schema failure is 400 invalid_body with paths and no received value", async () => {
    const { app, writeMeeting } = setup();
    const body = fireflies();
    delete (body.transcript as { id?: string }).id;
    (body.transcript as { title?: string }).title = MARK;
    const response = await send(app, JSON.stringify({ ...body, extra: MARK, date: MARK }));
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).not.toContain(MARK);
    const json = JSON.parse(text) as { error: string; issues: { path: string; message: string }[] };
    expect(json.error).toBe("invalid_body");
    expect(json.issues.map((i) => i.path)).toContain("transcript.id");
    expect(writeMeeting).not.toHaveBeenCalled();
  });

  it("source zoom is 400 invalid_body", async () => {
    const { app } = setup();
    const response = await send(app, JSON.stringify({ ...fireflies(), source: "zoom" }));
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe("invalid_body");
  });

  it("a string field over 1000 characters is 400 invalid_body", async () => {
    const { app, writeMeeting } = setup();
    const body = fireflies();
    body.transcript.title = "x".repeat(1001);
    const response = await send(app, JSON.stringify(body));
    expect(response.status).toBe(400);
    expect(writeMeeting).not.toHaveBeenCalled();
  });

  it("R1.6: a Gemini body that is not FILE_GENERATED is 409 transcript_not_ready", async () => {
    const { app, writeMeeting } = setup();
    const response = await send(app, JSON.stringify(gemini("STARTED")));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ ok: false, error: "transcript_not_ready" });
    expect(writeMeeting).not.toHaveBeenCalled();
  });
});

describe("POST /meetings secret source id (R8.7)", () => {
  const ghToken = ["gh", "p_", "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6"].join("");
  const oauthSecret = ["GOC", "SPX-", "Ab1Cd2Ef3Gh4Ij5Kl6Mn7O", "p8Qr9S"].join("");
  const MESSAGE = "must not contain a secret";

  async function expectRefused(path: string, body: unknown, secret: string): Promise<void> {
    const { app, writeMeeting, logs } = setup();
    const response = await send(app, JSON.stringify(body));
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      ok: false,
      error: "invalid_body",
      issues: [{ path, message: MESSAGE }],
    });
    expect(text).not.toContain(secret);
    expect(text).not.toContain(secret.slice(-8));
    expect(writeMeeting).not.toHaveBeenCalled();
    expect(logs.join("\n")).not.toContain(secret.slice(-8));
  }

  it("R8.7: a Fireflies id holding a token is 400 invalid_body naming transcript.id", async () => {
    const body = fireflies();
    body.transcript.id = ghToken;
    await expectRefused("transcript.id", body, ghToken);
  });

  it("R8.7: a Gemini name holding a client secret is 400 invalid_body naming transcript.name", async () => {
    const body = gemini();
    body.transcript.name = `conferenceRecords/c1/transcripts/${oauthSecret}`;
    await expectRefused("transcript.name", body, oauthSecret);
  });

  it("R8.7: an unfinished Gemini transcript with a secret id is still 409", async () => {
    const { app, writeMeeting } = setup();
    const body = gemini("STARTED");
    body.transcript.name = `conferenceRecords/c1/transcripts/${oauthSecret}`;
    const response = await send(app, JSON.stringify(body));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ ok: false, error: "transcript_not_ready" });
    expect(writeMeeting).not.toHaveBeenCalled();
  });
});

describe("POST /meetings write", () => {
  it("D2: a Fireflies body calls the writer once with the mapped input; stored is 201", async () => {
    const { app, writeMeeting } = setup();
    const response = await send(app, JSON.stringify(fireflies()));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(stored);
    expect(writeMeeting).toHaveBeenCalledTimes(1);
    const input = writeMeeting.mock.calls[0]?.[0];
    expect(input?.source).toBe("fireflies");
    expect(input?.sourceId).toBe("ff1");
  });

  it("D2: a Gemini body calls the writer once; an unmatched participant has speaker empty", async () => {
    const { app, writeMeeting } = setup();
    const response = await send(app, JSON.stringify(gemini()));
    expect(response.status).toBe(201);
    expect(writeMeeting).toHaveBeenCalledTimes(1);
    const input = writeMeeting.mock.calls[0]?.[0];
    expect(input?.source).toBe("gemini");
    expect(input?.sourceId).toBe("conferenceRecords/c1/transcripts/t1");
    expect(input?.segments[0]?.speaker).toBe("");
  });

  it("D2: already_stored and skipped answer 200", async () => {
    const already: MeetingOk = {
      ok: true,
      path: "meetings/a.md",
      commit: null,
      already_stored: true,
    };
    const short: MeetingOk = { ok: true, commit: null, skipped: "too_short" };
    for (const result of [already, short]) {
      const { app } = setup(result);
      const response = await send(app, JSON.stringify(fireflies()));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(result);
    }
  });

  it("logs rule=count and keeps redactions when non-empty; drops an empty list", async () => {
    const withRed: MeetingOk = { ...stored, redactions: [{ rule: "token", count: 2 }] };
    const a = setup(withRed);
    const ra = await send(a.app, JSON.stringify(fireflies()));
    expect(((await ra.json()) as { redactions?: unknown }).redactions).toEqual([
      { rule: "token", count: 2 },
    ]);
    expect(a.logs).toEqual(["redacted: token=2"]);

    const b = setup({ ...stored, redactions: [] });
    const rb = await send(b.app, JSON.stringify(fireflies()));
    expect(await rb.json()).toEqual(stored);
    expect(b.logs).toEqual([]);
  });

  it("a writer that throws ConfigInvalidError is 503 config_invalid", async () => {
    const { app, logs } = setup(new ConfigInvalidError(".2brain/config.yaml", "meetings.x", MARK));
    const response = await send(app, JSON.stringify(fireflies()));
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text).not.toContain(MARK);
    expect(JSON.parse(text).error).toBe("config_invalid");
    expect(logs.join("\n")).not.toContain(MARK);
  });

  it("an unknown writer error is 500 write_failed", async () => {
    const { app } = setup(new Error(MARK));
    const response = await send(app, JSON.stringify(fireflies()));
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(MARK);
  });
});
