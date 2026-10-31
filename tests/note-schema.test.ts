import { describe, expect, it } from "vitest";
import { isSafePathSegment, NoteInput } from "../src/vault/note-schema.js";

function accepts(path: string): boolean {
  return NoteInput.safeParse({ path, frontmatter: {}, body: "x" }).success;
}

describe("NoteInput.path: git pathspec magic", () => {
  it.each([":x.md", ":(top)x.md", ":/x.md"])("rejects a leading colon in %s", (path) => {
    expect(accepts(path)).toBe(false);
  });
});

describe("NoteInput.path: Windows-unsafe characters", () => {
  it.each(["<", ">", ":", '"', "|", "?", "*"])("rejects %s in a file name", (char) => {
    expect(accepts(`notes/a${char}b.md`)).toBe(false);
  });

  it.each(["<", ">", ":", '"', "|", "?", "*"])("rejects %s in a directory name", (char) => {
    expect(accepts(`a${char}b/c.md`)).toBe(false);
  });
});

describe("NoteInput.path: trailing dot or space", () => {
  it("rejects a directory ending in a dot", () => {
    expect(accepts("notes./x.md")).toBe(false);
  });

  it("rejects a directory ending in a space", () => {
    expect(accepts("notes /x.md")).toBe(false);
  });

  it("accepts a space before the extension, which Windows keeps", () => {
    expect(accepts("idea .md")).toBe(true);
  });
});

describe("NoteInput.path: reserved device names", () => {
  const names = ["con", "prn", "aux", "nul", "com1", "lpt1", "com9", "com0", "conin$", "conout$"];

  it.each(names)("rejects %s in lower, upper and mixed case", (name) => {
    const mixed = name.replace(/^./, (c) => c.toUpperCase());
    for (const form of [name, name.toUpperCase(), mixed]) {
      expect(accepts(`${form}.md`)).toBe(false);
    }
  });

  it.each(names)("rejects %s as a directory segment", (name) => {
    expect(accepts(`${name}/x.md`)).toBe(false);
    expect(accepts(`notes/${name.toUpperCase()}/x.md`)).toBe(false);
  });

  it("rejects a device name in a nested file and with extra extensions or spaces", () => {
    expect(accepts("notes/nul.md")).toBe(false);
    expect(accepts("con.tar.md")).toBe(false);
    expect(accepts("con .md")).toBe(false);
    expect(accepts("COM¹.md")).toBe(false);
  });
});

describe("NoteInput.path: accepted paths", () => {
  it.each([
    "Inbox/idea.md",
    "[ab].md",
    "console.md",
    "nul-results.md",
    "com10.md",
    "a b/c d.md",
    "notes/a.b.md",
  ])("accepts %s", (path) => {
    expect(accepts(path)).toBe(true);
  });
});

describe("isSafePathSegment", () => {
  it.each([
    "",
    ".hidden",
    "..",
    "a/b",
    "a\\b",
    "a\nb",
    "a:b",
    "end.",
    "end ",
    "CON",
    "Nul.txt",
    "lpt3.x.y",
  ])("rejects %j", (segment) => {
    expect(isSafePathSegment(segment)).toBe(false);
  });

  it.each(["Inbox", "idea.md", "a b", "[ab]", "console", "com10", "lpt", "x.con"])(
    "accepts %j",
    (segment) => {
      expect(isSafePathSegment(segment)).toBe(true);
    },
  );
});
