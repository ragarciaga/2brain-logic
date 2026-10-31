import matter from "gray-matter";
import { afterEach, describe, expect, it } from "vitest";
import { parseNote, parseYamlConfig, stringifyNote } from "../src/vault/frontmatter.js";

declare global {
  // Set by the injected `---js` payload if it ever runs.
  var __pwned: boolean | undefined;
}

afterEach(() => {
  globalThis.__pwned = undefined;
});

describe("stringifyNote", () => {
  it("always starts with a --- block, even for empty frontmatter", () => {
    expect(stringifyNote({}, "hello\n").startsWith("---\n{}\n---\n")).toBe(true);
    expect(stringifyNote({ a: 1 }, "hello\n").startsWith("---\na: 1\n---\n")).toBe(true);
  });

  it("does not let a ---js body become frontmatter, and runs no code", () => {
    const body = "---js\nglobalThis.__pwned = true\n---\nreal body\n";
    const stored = stringifyNote({}, body);
    expect(stored.startsWith("---\n{}\n---\n")).toBe(true);
    const viaDefaultMatter = matter(stored);
    expect(viaDefaultMatter.data).toEqual({});
    expect(viaDefaultMatter.content).toBe(body);
    expect(globalThis.__pwned).toBeUndefined();
  });

  it.each([{}, { a: 1 }])("round-trips a body that starts with its own fence (%j)", (fm) => {
    const body = "---\nk: v\n---\ntext\n";
    const parsed = parseNote(stringifyNote(fm, body));
    expect(parsed.data).toEqual(fm);
    expect(parsed.content).toBe(body);
  });

  const bodies: Array<[string, string]> = [
    ["empty", ""],
    ["no trailing newline", "no newline"],
    ["one trailing newline", "a\n"],
    ["two trailing newlines", "a\n\n"],
    ["CRLF", "a\r\nb\r\n"],
    ["a leading newline", "\nb\n"],
  ];

  it.each(bodies)("stores the body verbatim: %s", (_name, body) => {
    for (const fm of [{}, { a: 1 }]) {
      const stored = stringifyNote(fm, body);
      expect(stored.endsWith(body)).toBe(true);
      const parsed = parseNote(stored);
      expect(parsed.data).toEqual(fm);
      expect(parsed.content).toBe(body);
    }
  });

  it("round-trips a date-like string as a string", () => {
    const parsed = parseNote(stringifyNote({ date: "2026-10-31" }, "x\n"));
    expect(parsed.data).toEqual({ date: "2026-10-31" });
    expect(typeof parsed.data.date).toBe("string");
  });

  it("keeps fence-like keys and values inside the YAML block", () => {
    const fm = { "---": "a", note: "line one\n---\nline two", "---js": "x" };
    const parsed = parseNote(stringifyNote(fm, "body\n"));
    expect(parsed.data).toEqual(fm);
    expect(parsed.content).toBe("body\n");
  });
});

describe("parseNote", () => {
  it("keeps unquoted YAML timestamps as the strings they were written as", () => {
    const parsed = parseNote(
      "---\ndate: 2026-10-31\nat: 2026-10-31T10:00:00Z\nquoted: '2026-10-31'\n---\nx\n",
    );
    expect(parsed.data).toEqual({
      date: "2026-10-31",
      at: "2026-10-31T10:00:00Z",
      quoted: "2026-10-31",
    });
  });

  it("still resolves the other safe types and merge keys, and refuses custom tags", () => {
    const parsed = parseNote(
      "---\nn: 3\nb: true\nz: null\nbase: &b {x: 1}\nuse:\n  <<: *b\n  y: 2\n---\n",
    );
    expect(parsed.data).toEqual({ n: 3, b: true, z: null, base: { x: 1 }, use: { x: 1, y: 2 } });
    expect(() => parseNote("---\nf: !!js/function 'function(){}'\n---\n")).toThrow();
  });

  it("rejects an opening fence that names a language", () => {
    expect(() => parseNote("---js\nglobalThis.__pwned = true\n---\nx\n")).toThrow();
    expect(globalThis.__pwned).toBeUndefined();
  });

  it.each(["---yaml", "---json", "--- ", "---x"])(
    "rejects any language after the fence (%j)",
    (fence) => {
      expect(() => parseNote(`${fence}\na: 1\n---\nx\n`)).toThrow(/exactly ---/);
    },
  );

  it("rejects javascript fences in any spelling", () => {
    expect(() => parseNote("---JS\n1\n---\nx\n")).toThrow();
    expect(() => parseNote("---javascript\n1\n---\nx\n")).toThrow();
  });

  it("parses plain text without frontmatter as content", () => {
    expect(parseNote("just text\n")).toEqual({ data: {}, content: "just text\n" });
  });
});

describe("parseYamlConfig", () => {
  it("accepts a leading --- marker", () => {
    expect(parseYamlConfig("---\nvault:\n  archive_folder: Old\n")).toEqual({
      vault: { archive_folder: "Old" },
    });
  });

  it("parses a file without a marker", () => {
    expect(parseYamlConfig("vault:\n  archive_folder: Old\n")).toEqual({
      vault: { archive_folder: "Old" },
    });
  });

  it("throws on a second document", () => {
    expect(() => parseYamlConfig("a: 1\n---\nb: 2\n")).toThrow(/Multiple YAML documents/);
    expect(() => parseYamlConfig("---\na: 1\n---\nb: 2\n")).toThrow(/Multiple YAML documents/);
  });

  it("returns empty data for an empty or comment-only file", () => {
    expect(parseYamlConfig("")).toEqual({});
    expect(parseYamlConfig("# nothing here\n")).toEqual({});
  });

  it("does not run code from a js language tag inside the config", () => {
    expect(() => parseYamlConfig("a: 1\n--- js\n")).toThrow();
    expect(globalThis.__pwned).toBeUndefined();
  });
});
