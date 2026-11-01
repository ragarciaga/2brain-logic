import { describe, expect, it } from "vitest";
import {
  ConfigInvalidError,
  type VaultConfig,
  VaultConfigSchema,
} from "../src/config/vault-config.js";
import { FIELD_MAX, meetingFrontmatter } from "../src/meetings/frontmatter.js";
import type { MeetingInput } from "../src/meetings/types.js";
import { parseNote, stringifyNote } from "../src/vault/frontmatter.js";

function config(over: Record<string, unknown> = {}): VaultConfig {
  return VaultConfigSchema.parse(over);
}

const BOGOTA = config({ meetings: { timezone: "America/Bogota" } });

function input(over: Partial<MeetingInput> = {}): MeetingInput {
  return {
    source: "fireflies",
    sourceId: "01EXAMPLEID",
    start: new Date("2026-10-30T19:02:10Z"),
    end: new Date("2026-10-30T19:48:55Z"),
    sourceTitle: "Weekly sync",
    sourceUrl: "https://app.example.com/view/01EXAMPLEID",
    people: [],
    segments: [],
    calendarEvents: [],
    ...over,
  };
}

const CHOICE = { area: "work", event: { id: "evt_example_1", start: {}, end: {} } };

describe("meetingFrontmatter canonical keys", () => {
  it("writes type, area, date, source and source_id under the owner names, in design order", () => {
    const fm = meetingFrontmatter(input({ people: [{ name: "Ana Ruiz" }] }), CHOICE, BOGOTA, []);
    expect(fm).toEqual({
      type: "meeting",
      area: "work",
      date: "2026-10-30",
      source: "fireflies",
      source_id: "fireflies:01EXAMPLEID",
      start: "2026-10-30T14:02:10-05:00",
      end: "2026-10-30T14:48:55-05:00",
      duration_minutes: 46,
      participants: ["Ana Ruiz"],
      calendar_event: "evt_example_1",
      source_title: "Weekly sync",
      source_url: "https://app.example.com/view/01EXAMPLEID",
    });
    expect(Object.keys(fm)).toEqual([
      "type",
      "area",
      "date",
      "source",
      "source_id",
      "start",
      "end",
      "duration_minutes",
      "participants",
      "calendar_event",
      "source_title",
      "source_url",
    ]);
  });

  it("uses the configured source value in source and source_id", () => {
    const cfg = config({
      meetings: { sources: { fireflies: { value: "ff", label: "FF" } } },
    });
    const fm = meetingFrontmatter(input(), CHOICE, cfg, []);
    expect(fm.source).toBe("ff");
    expect(fm.source_id).toBe("ff:01EXAMPLEID");
  });

  it("throws ConfigInvalidError when the meeting type is missing", () => {
    const cfg = config();
    const types = { ...cfg.types };
    delete types.meeting;
    expect(() => meetingFrontmatter(input(), CHOICE, { ...cfg, types }, [])).toThrow(
      ConfigInvalidError,
    );
  });

  it("writes only the renamed properties", () => {
    const cfg = config({
      properties: { source_id: "origen" },
      meetings: { properties: { duration: "minutos" } },
    });
    const keys = Object.keys(meetingFrontmatter(input(), CHOICE, cfg, []));
    expect(keys).toContain("minutos");
    expect(keys).toContain("origen");
    expect(keys).not.toContain("duration_minutes");
    expect(keys).not.toContain("source_id");
  });

  it("writes every meeting property under its configured name", () => {
    const cfg = config({
      meetings: {
        properties: {
          start: "inicio",
          end: "fin",
          participants: "gente",
          calendar_event: "evento",
          source_title: "titulo",
          source_url: "enlace",
        },
      },
    });
    const keys = Object.keys(
      meetingFrontmatter(input({ people: [{ name: "Ana Ruiz" }] }), CHOICE, cfg, []),
    );
    expect(keys.slice(5)).toEqual([
      "inicio",
      "fin",
      "duration_minutes",
      "gente",
      "evento",
      "titulo",
      "enlace",
    ]);
  });

  it("keeps an owner property named __proto__ as an own key", () => {
    const cfg = config({ properties: { area: "__proto__" } });
    const fm = meetingFrontmatter(input(), CHOICE, cfg, []);
    expect(Object.hasOwn(fm, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(fm)).toBe(Object.prototype);
  });
});

describe("meetingFrontmatter time", () => {
  it("writes the offset -05:00 for America/Bogota", () => {
    const fm = meetingFrontmatter(input(), CHOICE, BOGOTA, []);
    expect(fm.start).toBe("2026-10-30T14:02:10-05:00");
  });

  it("writes +00:00 for UTC", () => {
    const fm = meetingFrontmatter(input(), CHOICE, config(), []);
    expect(fm.start).toBe("2026-10-30T19:02:10+00:00");
    expect(fm.end).toBe("2026-10-30T19:48:55+00:00");
  });

  it("uses the local date of the start", () => {
    const fm = meetingFrontmatter(
      input({ start: new Date("2026-10-31T03:30:00Z"), end: new Date("2026-10-31T04:30:00Z") }),
      CHOICE,
      BOGOTA,
      [],
    );
    expect(fm.date).toBe("2026-10-30");
    expect(fm.start).toBe("2026-10-30T22:30:00-05:00");
  });

  it("takes the date from the start when the end falls on another local day", () => {
    const fm = meetingFrontmatter(
      input({ start: new Date("2026-10-30T04:30:00Z"), end: new Date("2026-10-30T06:30:00Z") }),
      CHOICE,
      BOGOTA,
      [],
    );
    expect(fm.date).toBe("2026-10-29");
    expect(fm.end).toBe("2026-10-30T01:30:00-05:00");
  });

  it("writes a half-hour offset", () => {
    const cfg = config({ meetings: { timezone: "Asia/Kolkata" } });
    expect(meetingFrontmatter(input(), CHOICE, cfg, []).start).toBe("2026-10-31T00:32:10+05:30");
  });

  it("rounds the duration down", () => {
    expect(meetingFrontmatter(input(), CHOICE, BOGOTA, []).duration_minutes).toBe(46);
    const exact = input({ end: new Date("2026-10-30T19:48:10Z") });
    expect(meetingFrontmatter(exact, CHOICE, BOGOTA, []).duration_minutes).toBe(46);
  });
});

describe("meetingFrontmatter participants", () => {
  const fm = (people: MeetingInput["people"], persons: string[] = []) =>
    meetingFrontmatter(input({ people }), CHOICE, BOGOTA, persons).participants;

  it("drops duplicate emails in a different case and keeps order", () => {
    expect(
      fm([
        { name: "Bo Chen", email: "Bo@Example.com" },
        { name: "Ana Ruiz", email: "ana@example.com" },
        { email: "bo@example.com" },
      ]),
    ).toEqual(["Bo Chen", "Ana Ruiz"]);
  });

  it("drops duplicate names in a different case when there is no email", () => {
    expect(fm([{ name: "Bo Chen" }, { name: "bo chen" }, { name: "Cy Dole" }])).toEqual([
      "Bo Chen",
      "Cy Dole",
    ]);
  });

  it("drops a bare email that follows an attendee with the same email", () => {
    expect(fm([{ name: "Bo Chen", email: "bo@example.com" }, { email: "BO@example.com" }])).toEqual(
      ["Bo Chen"],
    );
  });

  it("drops entries with neither name nor email", () => {
    expect(fm([{}, { name: "  " }, { name: "Bo Chen" }])).toEqual(["Bo Chen"]);
  });

  it("links a name equal to a person base name, case-insensitive", () => {
    expect(fm([{ name: "ana ruiz" }, { email: "dev@example.com" }], ["Ana Ruiz"])).toEqual([
      "[[Ana Ruiz]]",
      "dev@example.com",
    ]);
  });

  it("omits the key when nobody is known", () => {
    const out = meetingFrontmatter(input({ people: [] }), CHOICE, BOGOTA, []);
    expect(Object.hasOwn(out, "participants")).toBe(false);
  });
});

describe("meetingFrontmatter absent values", () => {
  it("omits calendar_event, source_title and source_url when absent", () => {
    const fm = meetingFrontmatter(
      input({ sourceTitle: undefined, sourceUrl: undefined }),
      { area: "work" },
      BOGOTA,
      [],
    );
    for (const name of ["calendar_event", "source_title", "source_url"]) {
      expect(Object.hasOwn(fm, name)).toBe(false);
    }
    expect(Object.values(fm).includes(null)).toBe(false);
  });

  it("omits a blank title", () => {
    const fm = meetingFrontmatter(input({ sourceTitle: "  " }), CHOICE, BOGOTA, []);
    expect(Object.hasOwn(fm, "source_title")).toBe(false);
  });
});

describe("meetingFrontmatter url and caps", () => {
  const url = (sourceUrl: string) =>
    meetingFrontmatter(input({ sourceUrl }), CHOICE, BOGOTA, []).source_url;

  it("strips userinfo and keeps the link", () => {
    expect(url("https://u:p@app.example.com/x")).toBe("https://app.example.com/x");
  });

  it("omits a non-https, unparseable or over-cap URL", () => {
    expect(url("http://app.example.com/x")).toBeUndefined();
    expect(url("not a url")).toBeUndefined();
    expect(url(`https://app.example.com/${"a".repeat(FIELD_MAX)}`)).toBeUndefined();
  });

  it("keeps a URL of exactly the cap", () => {
    const prefix = "https://app.example.com/";
    const exact = prefix + "a".repeat(FIELD_MAX - prefix.length);
    expect(url(exact)).toBe(exact);
  });

  it("leaves no CR, LF or tab in the stored URL", () => {
    const stored = url("https://app.example.com/a\r\nb\tc");
    expect(stored).toBeDefined();
    expect(stored).not.toMatch(/[\r\n\t]/);
  });

  it("cuts a long title to the cap in code points", () => {
    const title = "\u{1F600}".repeat(1200);
    const out = meetingFrontmatter(input({ sourceTitle: title }), CHOICE, BOGOTA, []);
    expect(Array.from(out.source_title as string)).toHaveLength(FIELD_MAX);
  });

  it("omits an over-cap event id and keeps one of the cap", () => {
    const long = { area: "work", event: { id: "e".repeat(FIELD_MAX + 1), start: {}, end: {} } };
    expect(Object.hasOwn(meetingFrontmatter(input(), long, BOGOTA, []), "calendar_event")).toBe(
      false,
    );
    const exact = { area: "work", event: { id: "e".repeat(FIELD_MAX), start: {}, end: {} } };
    expect(meetingFrontmatter(input(), exact, BOGOTA, []).calendar_event).toBe(
      "e".repeat(FIELD_MAX),
    );
  });
});

describe("meetingFrontmatter YAML round trip", () => {
  it("survives stringifyNote and parseNote", () => {
    const fm = meetingFrontmatter(
      input({ sourceTitle: "Plan: a # b 'c'\nsecond line", people: [{ name: "Ana Ruiz" }] }),
      CHOICE,
      BOGOTA,
      ["Ana Ruiz"],
    );
    expect(parseNote(stringifyNote(fm, "")).data).toEqual(fm);
  });
});
