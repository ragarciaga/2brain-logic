import { describe, expect, it } from "vitest";
import { DEFAULT_VAULT_CONFIG } from "../src/config/defaults.js";
import type { VaultConfig } from "../src/config/vault-config.js";
import { validateFrontmatter } from "../src/vault/validate.js";

function config(edit?: (c: VaultConfig) => void): VaultConfig {
  const c = structuredClone(DEFAULT_VAULT_CONFIG);
  edit?.(c);
  return c;
}

const goodFm = { type: "meeting", area: "work", date: "2026-03-14", source: "calendar" };
const goodPath = "work/meetings/2026-03-14-sync.md";

function check(fm: Record<string, unknown>, path = goodPath, c: VaultConfig = config()) {
  return validateFrontmatter(fm, path, c);
}

function invalid(missing: string[], bad: string[]) {
  return { ok: false, error: "invalid_frontmatter", missing, invalid: bad };
}

describe("validateFrontmatter: required properties", () => {
  it("accepts a complete note and reports the type key and area", () => {
    expect(check(goodFm)).toStrictEqual({ ok: true, typeKey: "meeting", area: "work" });
  });

  it.each(["type", "area", "date", "source"])(
    "reports %s missing when it is the only gap",
    (name) => {
      const { [name]: _dropped, ...rest } = goodFm as Record<string, unknown>;
      expect(check(rest)).toStrictEqual(invalid([name], []));
    },
  );

  it("lists all missing names in canonical order", () => {
    expect(check({ source_id: "x" })).toStrictEqual(
      invalid(["type", "area", "date", "source"], []),
    );
  });

  it("treats null as missing", () => {
    expect(check({ ...goodFm, area: null })).toStrictEqual(invalid(["area"], []));
  });

  it("uses the owner-mapped property names", () => {
    const c = config((x) => {
      x.properties = {
        type: "kind",
        area: "zone",
        date: "when",
        source: "origin",
        source_id: "ref",
      };
    });
    const fm = { kind: "meeting", zone: "work", when: "2026-03-14", origin: "calendar" };
    expect(check(fm, goodPath, c)).toStrictEqual({ ok: true, typeKey: "meeting", area: "work" });
    expect(check({}, goodPath, c)).toStrictEqual(invalid(["kind", "zone", "when", "origin"], []));
    expect(check({ ...fm, when: "nope" }, goodPath, c)).toStrictEqual(invalid([], ["when"]));
  });

  it("does not check source_id", () => {
    expect(check({ ...goodFm, source_id: 42 }).ok).toBe(true);
  });
});

describe("validateFrontmatter: type and area values", () => {
  it("rejects an unknown or non-string type", () => {
    expect(check({ ...goodFm, type: "memo" })).toStrictEqual(invalid([], ["type"]));
    expect(check({ ...goodFm, type: 3 })).toStrictEqual(invalid([], ["type"]));
  });

  it("matches the type by the owner value, not by the canonical key", () => {
    const c = config((x) => {
      x.types = { meeting: { value: "reunion", folder: "{area}/meetings" } };
    });
    expect(check({ ...goodFm, type: "reunion" }, goodPath, c)).toStrictEqual({
      ok: true,
      typeKey: "meeting",
      area: "work",
    });
    expect(check({ ...goodFm, type: "meeting" }, goodPath, c)).toStrictEqual(invalid([], ["type"]));
  });

  it("rejects an unknown or non-string area", () => {
    expect(check({ ...goodFm, area: "play" })).toStrictEqual(invalid([], ["area"]));
    expect(check({ ...goodFm, area: ["work"] })).toStrictEqual(invalid([], ["area"]));
  });
});

describe("validateFrontmatter: date", () => {
  it.each(["2024-02-29", "2000-02-29", "0050-01-01", "2026-12-31"])("accepts %s", (date) => {
    expect(check({ ...goodFm, date }).ok).toBe(true);
  });

  it.each([
    "2026-13-01",
    "2026-00-10",
    "2026-01-00",
    "2026-04-31",
    "2023-02-29",
    "1900-02-29",
    "2026-1-5",
    "2026-03-14T10:00:00Z",
    " 2026-03-14",
    "2026-03-14\n",
    "２０２６-０３-１４",
    "",
  ])("rejects the string %j", (date) => {
    expect(check({ ...goodFm, date })).toStrictEqual(invalid([], ["date"]));
  });

  it("rejects a number and a Date object", () => {
    expect(check({ ...goodFm, date: 20260314 })).toStrictEqual(invalid([], ["date"]));
    expect(check({ ...goodFm, date: new Date("2026-03-14") })).toStrictEqual(invalid([], ["date"]));
  });
});

describe("validateFrontmatter: source", () => {
  it("accepts any non-empty string when the allow-list is empty", () => {
    expect(check({ ...goodFm, source: "anything" }).ok).toBe(true);
  });

  it("rejects an empty or non-string source whatever the allow-list", () => {
    expect(check({ ...goodFm, source: "" })).toStrictEqual(invalid([], ["source"]));
    expect(check({ ...goodFm, source: 7 })).toStrictEqual(invalid([], ["source"]));
  });

  it("restricts source to a non-empty allow-list", () => {
    const c = config((x) => {
      x.sources = ["calendar", "mail"];
    });
    expect(check(goodFm, goodPath, c).ok).toBe(true);
    expect(check({ ...goodFm, source: "chat" }, goodPath, c)).toStrictEqual(
      invalid([], ["source"]),
    );
  });

  it("reports several invalid properties at once", () => {
    expect(check({ type: "memo", area: "play", date: "x", source: "" })).toStrictEqual(
      invalid([], ["type", "area", "date", "source"]),
    );
    expect(check({ type: "memo", area: "work", date: "2026-03-14" })).toStrictEqual(
      invalid(["source"], ["type"]),
    );
  });
});

describe("validateFrontmatter: folder", () => {
  it("expands {area} and requires the path inside the folder", () => {
    expect(check(goodFm, "personal/meetings/a.md")).toStrictEqual({
      ok: false,
      error: "wrong_folder",
      expected: "work/meetings",
    });
  });

  it("requires the folder as a whole segment", () => {
    expect(check(goodFm, "work/meetings-old/a.md")).toStrictEqual({
      ok: false,
      error: "wrong_folder",
      expected: "work/meetings",
    });
    expect(check(goodFm, "work/meetings")).toMatchObject({ error: "wrong_folder" });
  });

  it("allows subfolders and is case-sensitive", () => {
    expect(check(goodFm, "work/meetings/2026/a.md").ok).toBe(true);
    expect(check(goodFm, "Work/meetings/a.md")).toMatchObject({ error: "wrong_folder" });
  });

  it("handles a folder without {area}", () => {
    const fm = { ...goodFm, type: "topic" };
    expect(check(fm, "topics/a.md").ok).toBe(true);
    expect(check(fm, "work/topics/a.md")).toStrictEqual({
      ok: false,
      error: "wrong_folder",
      expected: "topics",
    });
  });

  it("accepts any path for a type without a folder", () => {
    const c = config((x) => {
      x.types = { note: { value: "note" } };
    });
    expect(check({ ...goodFm, type: "note" }, "anywhere/at/all.md", c).ok).toBe(true);
  });

  it("reports a frontmatter problem before a folder problem", () => {
    expect(check({ ...goodFm, date: "bad" }, "elsewhere/a.md")).toStrictEqual(
      invalid([], ["date"]),
    );
    expect(check({ type: "meeting" }, "elsewhere/a.md")).toMatchObject({
      error: "invalid_frontmatter",
    });
  });
});

describe("validateFrontmatter: prototype names and value echo", () => {
  const protoConfig = config((x) => {
    x.properties = {
      type: "constructor",
      area: "__proto__",
      date: "toString",
      source: "valueOf",
      source_id: "id",
    };
  });

  it("treats inherited owner names as missing", () => {
    expect(check({}, goodPath, protoConfig)).toStrictEqual(
      invalid(["constructor", "__proto__", "toString", "valueOf"], []),
    );
  });

  it("reads an own __proto__ key", () => {
    const fm = JSON.parse(
      '{"constructor":"meeting","__proto__":"work","toString":"2026-03-14","valueOf":"calendar"}',
    ) as Record<string, unknown>;
    expect(check(fm, goodPath, protoConfig)).toStrictEqual({
      ok: true,
      typeKey: "meeting",
      area: "work",
    });
  });

  it("matches a type key named constructor by value and an area named constructor", () => {
    const c = config((x) => {
      x.areas = ["constructor"];
      x.types = { constructor: { value: "ctor", folder: "{area}/c" } };
    });
    expect(
      check({ ...goodFm, type: "ctor", area: "constructor" }, "constructor/c/a.md", c),
    ).toStrictEqual({
      ok: true,
      typeKey: "constructor",
      area: "constructor",
    });
    expect(check({ ...goodFm, type: "constructor", area: "work" }, goodPath, c)).toStrictEqual(
      invalid([], ["type", "area"]),
    );
  });

  it("never carries a value from the note in an error result", () => {
    const secret = "sk-ant-SECRET-VALUE";
    const verdicts = [
      check({ ...goodFm, type: secret, area: secret, date: secret, source: "" }),
      check(
        { ...goodFm, source: secret },
        goodPath,
        config((x) => {
          x.sources = ["mail"];
        }),
      ),
      check({ ...goodFm, source_id: secret }, "elsewhere/a.md"),
    ];
    for (const verdict of verdicts) {
      expect(verdict.ok).toBe(false);
      expect(JSON.stringify(verdict)).not.toContain(secret);
    }
  });
});
