import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_VAULT_CONFIG } from "../src/config/defaults.js";
import { ConfigInvalidError, type VaultConfig } from "../src/config/vault-config.js";
import {
  cleanTitle,
  localParts,
  meetingFolder,
  meetingPath,
  meetingTitle,
  withTimeSuffix,
} from "../src/meetings/name.js";
import { NotePath } from "../src/vault/note-schema.js";

const cfg = (over: Partial<VaultConfig["meetings"]> = {}, tz = "America/Bogota"): VaultConfig => ({
  ...DEFAULT_VAULT_CONFIG,
  meetings: { ...DEFAULT_VAULT_CONFIG.meetings, timezone: tz, ...over },
});
const START = new Date("2026-10-31T03:30:00Z");

function scrubTitle(index: number): string {
  const file = JSON.parse(readFileSync("tests/fixtures/scrub/positive.json", "utf8")) as {
    text: { parts: string[] }[];
  };
  return (file.text[index]?.parts ?? []).join("");
}

describe("date in time zone", () => {
  it("uses meetings.timezone", () => {
    expect(localParts(START, "America/Bogota")).toEqual({ date: "2026-10-30", hhmm: "22-30" });
    expect(localParts(START, "UTC")).toEqual({ date: "2026-10-31", hhmm: "03-30" });
  });
  it("gives 00 at local midnight, never 24", () => {
    expect(localParts(new Date("2026-10-31T05:05:00Z"), "America/Bogota").hhmm).toBe("00-05");
  });
  it("no event gives the untitled name", () => {
    const r = meetingPath(undefined, START, "work", cfg());
    expect(r.base).toBe("2026-10-30 · Untitled meeting 22-30");
  });
  it("an event gives its title", () => {
    const r = meetingPath({ id: "e", title: "Weekly sync" } as never, START, "work", cfg());
    expect(r.base).toBe("2026-10-30 · Weekly sync");
    expect(r.folder).toBe("work/meetings");
    expect(r.path).toBe("work/meetings/2026-10-30 · Weekly sync.md");
  });
});

describe("cleanTitle", () => {
  it.each([...'<>:"/\\|?*[]#^', "\u0000", "\n", "\u007f"])("replaces %j with a space", (ch) => {
    expect(cleanTitle(`a${ch}b`)).toBe("a b");
  });
  it("a mixed run gives one space", () => {
    expect(cleanTitle('a<>:"/\\|?*[]#^\n\tb')).toBe("a b");
  });
  it("collapses spaces and trims edges", () => {
    expect(cleanTitle("a    b")).toBe("a b");
    expect(cleanTitle("..Plan.. ")).toBe("Plan");
    expect(cleanTitle(" . . x . . ")).toBe("x");
  });
});

describe("length", () => {
  it("cuts a 400-char title so the path is at most 255", () => {
    const r = meetingPath({ id: "e", title: "ab ".repeat(140) } as never, START, "work", cfg());
    expect(r.path.length).toBeLessThanOrEqual(255);
    expect(r.path.endsWith(".md")).toBe(true);
    expect(r.base).not.toMatch(/[ .]$/);
    expect(NotePath.safeParse(r.path).success).toBe(true);
  });
  it("leaves room for the collision suffixes", () => {
    const c = cfg();
    const r = meetingPath({ id: "e", title: "x".repeat(400) } as never, START, "work", c);
    const longest = Math.max(...Object.values(c.meetings.sources).map((s) => s.label.length));
    const final = `${withTimeSuffix(r.base, START, c)} (${"y".repeat(longest)})`;
    expect(`${r.folder}/${final}.md`.length).toBeLessThanOrEqual(255);
  });
  it("does not split a surrogate pair", () => {
    const r = meetingPath(
      { id: "e", title: "\u{1F600}".repeat(400) } as never,
      START,
      "work",
      cfg(),
    );
    expect(r.path.length).toBeLessThanOrEqual(255);
    expect(r.base).not.toMatch(
      /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/,
    );
    expect(r.base.endsWith("\u{1F600}")).toBe(true);
  });
  it("a cut that ends in dots is re-trimmed", () => {
    expect(meetingTitle({ id: "e", title: "abc...def" } as never, START, cfg(), 6)).toBe("abc");
  });
});

describe("fallbacks", () => {
  it("a title empty after cleaning gives the untitled name", () => {
    expect(meetingTitle({ id: "e", title: "???" } as never, START, cfg(), 100)).toBe(
      "Untitled meeting 22-30",
    );
  });
  it("a scrub hit gives the untitled name and the path holds none of it", () => {
    const secret = scrubTitle(6);
    expect(secret).toContain("ghp_");
    const r = meetingPath({ id: "e", title: secret } as never, START, "work", cfg());
    expect(r.base).toBe("2026-10-30 · Untitled meeting 22-30");
    expect(r.path).not.toContain("ghp_");
    expect(r.path).not.toContain("clone");
  });
  it("a labeled secret title is replaced too", () => {
    const r = meetingPath({ id: "e", title: scrubTitle(25) } as never, START, "work", cfg());
    expect(r.path).not.toContain("hunter");
  });
  it("cleans the untitled label (D2)", () => {
    expect(meetingTitle(undefined, START, cfg({ untitled_label: "a/b" }), 100)).toBe("a b 22-30");
  });
  it("an empty label falls back to the default", () => {
    expect(meetingTitle(undefined, START, cfg({ untitled_label: "..." }), 100)).toBe(
      "Untitled meeting 22-30",
    );
  });
  it("a label that is a scrub hit falls back to the default", () => {
    const label = scrubTitle(6);
    const name = meetingTitle(undefined, START, cfg({ untitled_label: label }), 100);
    expect(name).toBe("Untitled meeting 22-30");
  });
  it("a very long label is cut", () => {
    const r = meetingPath(undefined, START, "work", cfg({ untitled_label: "L".repeat(400) }));
    expect(r.path.length).toBeLessThanOrEqual(255);
  });
});

describe("folder", () => {
  it("replaces {area}", () => {
    expect(meetingFolder(cfg(), "work")).toBe("work/meetings");
    const custom = cfg();
    const meeting = custom.types.meeting;
    const c2: VaultConfig = {
      ...custom,
      types: { ...custom.types, meeting: { ...meeting, folder: "notes/{area}/m" } as never },
    };
    expect(meetingFolder(c2, "personal")).toBe("notes/personal/m");
    expect(meetingPath(undefined, START, "personal", c2).path.startsWith("notes/personal/m/")).toBe(
      true,
    );
  });
  it("throws ConfigInvalidError without a meeting type", () => {
    const { meeting: _m, ...rest } = DEFAULT_VAULT_CONFIG.types;
    const c: VaultConfig = { ...DEFAULT_VAULT_CONFIG, types: rest };
    try {
      meetingFolder(c, "work");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigInvalidError);
      expect((e as ConfigInvalidError).keyPath).toBe("types.meeting");
    }
  });
  it("throws for an unknown area", () => {
    expect(() => meetingFolder(cfg(), "nope")).toThrow(/not one of the configured areas/);
  });
});

describe("withTimeSuffix", () => {
  it("appends the local HH-MM", () => {
    expect(withTimeSuffix("2026-10-30 · Weekly sync", START, cfg())).toBe(
      "2026-10-30 · Weekly sync 22-30",
    );
  });
});

describe("every path is a valid NotePath", () => {
  it.each(["a/b", "CON", "x".repeat(400), "???", "..", "ok"])("title %#", (title) => {
    const r = meetingPath({ id: "e", title } as never, START, "work", cfg());
    expect(NotePath.safeParse(r.path).success).toBe(true);
  });
});
