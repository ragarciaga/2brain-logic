import { describe, expect, it } from "vitest";
import { DEFAULT_VAULT_CONFIG } from "../src/config/defaults.js";
import type { VaultConfig } from "../src/config/vault-config.js";
import type { MeetingInput } from "../src/meetings/types.js";
import {
  isVersionCandidate,
  matchVersion,
  type VersionCandidate,
} from "../src/meetings/versions.js";

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 30, 10, 0, 0);
const at = (minutes: number) => new Date(T0 + minutes * MIN);

function input(startMin: number, endMin: number, source: MeetingInput["source"] = "fireflies") {
  return { source, start: at(startMin), end: at(endMin) } as MeetingInput;
}

function cand(
  path: string,
  startMin: number,
  endMin: number,
  over: Partial<VersionCandidate> = {},
): VersionCandidate {
  return { path, source: "gemini", start: at(startMin), end: at(endMin), ...over };
}

describe("matchVersion", () => {
  it("no candidates gives undefined", () => {
    expect(matchVersion(input(0, 60), "ev1", [])).toBeUndefined();
  });

  it("same event id matches without overlap", () => {
    const c = cand("work/meetings/a.md", 500, 560, { calendarEvent: "ev1" });
    expect(matchVersion(input(0, 60), "ev1", [c])).toBe("work/meetings/a.md");
  });

  it("different event id and no overlap does not match", () => {
    const c = cand("a.md", 500, 560, { calendarEvent: "ev2" });
    expect(matchVersion(input(0, 60), "ev1", [c])).toBeUndefined();
  });

  it("no event id on input never matches by event", () => {
    expect(matchVersion(input(0, 60), undefined, [cand("a.md", 500, 560)])).toBeUndefined();
  });

  it("49% does not match, 50% matches (candidate longer)", () => {
    // input is the shorter one: 60 min. 29.4 min overlap is 49%, 30 min is 50%.
    const short = Math.round(29.4 * MIN);
    const i = { ...input(0, 60) };
    const c49 = { ...cand("a.md", 0, 100), start: new Date(T0 + 60 * MIN - short), end: at(160) };
    expect(matchVersion(i, undefined, [c49])).toBeUndefined();
    expect(matchVersion(i, undefined, [cand("a.md", 30, 130)])).toBe("a.md");
  });

  it("49% does not match, 50% matches (input longer)", () => {
    const i = input(0, 100);
    // candidate is the shorter one: 60 min.
    const c49 = {
      ...cand("a.md", 0, 60),
      start: new Date(T0 + 100 * MIN - Math.round(29.4 * MIN)),
      end: new Date(T0 + 100 * MIN - Math.round(29.4 * MIN) + 60 * MIN),
    };
    expect(matchVersion(i, undefined, [c49])).toBeUndefined();
    expect(matchVersion(i, undefined, [cand("a.md", 70, 130)])).toBe("a.md");
  });

  it("longest overlap wins whatever the position", () => {
    const low = cand("low.md", 30, 90);
    const mid = cand("mid.md", 20, 80);
    const high = cand("high.md", 0, 60);
    for (const list of [
      [low, mid, high],
      [high, low, mid],
      [mid, high, low],
    ]) {
      expect(matchVersion(input(0, 60), undefined, list)).toBe("high.md");
    }
  });

  it("ties go to the smaller path in both orders", () => {
    const a = cand("a/x.md", 0, 60);
    const b = cand("b/x.md", 0, 60);
    expect(matchVersion(input(0, 60), undefined, [a, b])).toBe("a/x.md");
    expect(matchVersion(input(0, 60), undefined, [b, a])).toBe("a/x.md");
  });

  it("same source never matches, even with the same event id", () => {
    const same = cand("a.md", 0, 60, { source: "fireflies", calendarEvent: "ev1" });
    expect(matchVersion(input(0, 60), "ev1", [same])).toBeUndefined();
  });

  it("a same-source note with longer overlap does not shadow the other source", () => {
    const same = cand("a.md", 0, 60, { source: "fireflies" });
    const other = cand("z.md", 30, 90);
    expect(matchVersion(input(0, 60), undefined, [same, other])).toBe("z.md");
  });
});

describe("isVersionCandidate", () => {
  const cfg = DEFAULT_VAULT_CONFIG;
  const note = (path: string, date: unknown, type: unknown = "meeting") => ({
    path,
    data: { type, date },
  });

  it("same day and one day apart are kept", () => {
    expect(isVersionCandidate(note("work/meetings/x.md", "2026-10-30"), "2026-10-30", cfg)).toBe(
      true,
    );
    expect(isVersionCandidate(note("work/meetings/x.md", "2026-10-29"), "2026-10-30", cfg)).toBe(
      true,
    );
    expect(isVersionCandidate(note("work/meetings/x.md", "2026-10-31"), "2026-10-30", cfg)).toBe(
      true,
    );
  });

  it("two days apart is ignored", () => {
    expect(isVersionCandidate(note("work/meetings/x.md", "2026-10-28"), "2026-10-30", cfg)).toBe(
      false,
    );
    expect(isVersionCandidate(note("work/meetings/x.md", "2026-11-01"), "2026-10-30", cfg)).toBe(
      false,
    );
  });

  it("month boundary is kept", () => {
    expect(isVersionCandidate(note("work/meetings/x.md", "2026-10-31"), "2026-11-01", cfg)).toBe(
      true,
    );
  });

  it("archived note is ignored", () => {
    expect(
      isVersionCandidate(note("archive/work/meetings/x.md", "2026-10-30"), "2026-10-30", cfg),
    ).toBe(false);
  });

  it("a folder named like the archive is kept", () => {
    expect(isVersionCandidate(note("archived/x.md", "2026-10-30"), "2026-10-30", cfg)).toBe(true);
  });

  it("a note that is not a meeting is ignored", () => {
    expect(
      isVersionCandidate(note("work/meetings/x.md", "2026-10-30", "analysis"), "2026-10-30", cfg),
    ).toBe(false);
  });

  it("missing or non-string date is ignored", () => {
    expect(isVersionCandidate(note("x.md", undefined), "2026-10-30", cfg)).toBe(false);
    expect(
      isVersionCandidate(note("x.md", new Date(Date.UTC(2026, 9, 30))), "2026-10-30", cfg),
    ).toBe(false);
    expect(isVersionCandidate(note("x.md", "2026-10-30T10:00:00Z"), "2026-10-30", cfg)).toBe(false);
  });

  it("an invalid new date is false", () => {
    expect(isVersionCandidate(note("x.md", "2026-10-30"), "30/10/2026", cfg)).toBe(false);
  });

  it("renamed properties and archive folder are honored", () => {
    const renamed: VaultConfig = {
      ...cfg,
      vault: { ...cfg.vault, archive_folder: "old" },
      properties: { ...cfg.properties, date: "fecha" },
    };
    const n = { path: "work/meetings/x.md", data: { type: "meeting", fecha: "2026-10-30" } };
    expect(isVersionCandidate(n, "2026-10-30", renamed)).toBe(true);
    expect(isVersionCandidate({ ...n, path: "old/x.md" }, "2026-10-30", renamed)).toBe(false);
    expect(isVersionCandidate({ ...n, path: "archive/x.md" }, "2026-10-30", renamed)).toBe(true);
    expect(isVersionCandidate(note("x.md", "2026-10-30"), "2026-10-30", renamed)).toBe(false);
  });

  it("no meeting type is false", () => {
    const { meeting: _m, ...rest } = cfg.types;
    expect(
      isVersionCandidate(note("x.md", "2026-10-30"), "2026-10-30", { ...cfg, types: rest }),
    ).toBe(false);
  });
});
