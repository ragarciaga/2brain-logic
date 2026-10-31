import { describe, expect, it } from "vitest";
import { parseLogRecords } from "../src/git/index.js";

const M = "abc123";
const RS = "\x1e";
const D1 = "2026-10-30T10:00:00+00:00";
const D2 = "2026-10-20T10:00:00+00:00";

const expected = [
  { path: "inbox/a.md", date: D1 },
  { path: "inbox/b.md", date: D1 },
  { path: "inbox/c.md", date: D2 },
];

describe("parseLogRecords", () => {
  it("parses the date, NUL, newline layout", () => {
    const out = Buffer.from(
      `${RS}${M}${D1}\0\ninbox/a.md\0inbox/b.md\0${RS}${M}${D2}\0\ninbox/c.md\0`,
    );
    expect(parseLogRecords(out, M)).toEqual(expected);
  });

  it("parses the date, newline, NUL layout and ignores empty names", () => {
    const out = Buffer.from(
      `${RS}${M}${D1}\n\0inbox/a.md\0\0inbox/b.md\0${RS}${M}${D2}\n\0\0inbox/c.md\0\0`,
    );
    expect(parseLogRecords(out, M)).toEqual(expected);
  });

  it("ignores a forged header that does not carry the marker", () => {
    const out = Buffer.from(
      `${RS}${M}${D2}\0\ninbox/a${RS}2099-01-01T00:00:00+00:00\0inbox/z.md\0`,
    );
    expect(parseLogRecords(out, M)).toEqual([
      { path: "inbox/a\x1e2099-01-01T00:00:00+00:00", date: D2 },
      { path: "inbox/z.md", date: D2 },
    ]);
  });

  it("ignores a header with a non ISO date", () => {
    const out = Buffer.from(`${RS}${M}2099-01-01\0\ninbox/a.md\0`);
    expect(parseLogRecords(out, M)).toEqual([]);
  });

  it("accepts a Z date in the layout git 2.56 prints for UTC", () => {
    const out = Buffer.from("\x1eMK2026-10-29T13:24:18Z\0\na.md\0");
    expect(parseLogRecords(out, "MK")).toEqual([{ path: "a.md", date: "2026-10-29T13:24:18Z" }]);
  });

  it("rejects a malformed zone suffix", () => {
    const out = Buffer.from("\x1eMK2026-10-29T13:24:18ZZ\0\na.md\0");
    expect(parseLogRecords(out, "MK")).toEqual([]);
  });

  it("drops records older than since, whatever git returned", () => {
    const out = Buffer.from(`${RS}${M}${D1}\0\ninbox/a.md\0${RS}${M}${D2}\0\ninbox/c.md\0`);
    expect(parseLogRecords(out, M, new Date("2026-10-25T00:00:00Z"))).toEqual([
      { path: "inbox/a.md", date: D1 },
    ]);
  });
});
