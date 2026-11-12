import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultGit, ensureClone } from "../src/git/index.js";
import { FIELD_MAX } from "../src/meetings/frontmatter.js";
import type { MeetingInput } from "../src/meetings/types.js";
import { parseNote } from "../src/vault/frontmatter.js";
import { createNoteWriter } from "../src/vault/write-note.js";
import { createGitFixture, type GitFixture, TEST_AUTHOR } from "./helpers/git-fixture.js";
import { meetingInput, pushFiles } from "./helpers/meeting-vault.js";

// B264: a participant is linked by name or email, ignoring case and accents, against the base
// name and the `aliases` of a person note. The aliases live in the note, so they reach
// `participants()` only through the vault writer; that is the lowest level that shows the bug.

let fixture: GitFixture;

const PERSON_NOTE = [
  "---",
  "type: person",
  "aliases:",
  "  - Maria P.",
  "  - mpuch@example.com",
  "---",
  "",
  "Fictional person.",
  "",
].join("\n");

async function storedParticipants(people: MeetingInput["people"]): Promise<unknown> {
  const writer = createNoteWriter({
    vaultDir: fixture.vaultDir,
    author: TEST_AUTHOR,
    git: defaultGit,
    log: () => {},
    sleep: () => Promise.resolve(),
  });
  const result = await writer.writeMeeting(meetingInput(46, { people }));
  const path = (result as { path?: string }).path;
  if (path === undefined) throw new Error(`meeting not stored: ${JSON.stringify(result)}`);
  return parseNote(readFileSync(join(fixture.vaultDir, path), "utf8")).data.participants;
}

beforeEach(async () => {
  fixture = createGitFixture();
  await ensureClone(fixture.vaultDir, fixture.remote);
  pushFiles(fixture, {
    "people/María Puch.md": PERSON_NOTE,
    "people/Hannah.md": "---\ntype: person\naliases: [Hannah Eskinder]\n---\n",
  });
});

afterEach(() => {
  fixture.cleanup();
});

describe("meeting participant links (B264)", () => {
  it("links a name that differs from the base name only by accents and case", async () => {
    expect(await storedParticipants([{ name: "maria puch" }])).toEqual(["[[María Puch]]"]);
  });

  it("links a name listed in the aliases of a person note", async () => {
    expect(await storedParticipants([{ name: "hannah eskinder" }])).toEqual(["[[Hannah]]"]);
  });

  it("links an email listed in the aliases of a person note", async () => {
    expect(await storedParticipants([{ email: "MPuch@example.com" }])).toEqual(["[[María Puch]]"]);
  });

  it("links by the email when the display name is unknown", async () => {
    expect(await storedParticipants([{ name: "M. P.", email: "mpuch@example.com" }])).toEqual([
      "[[María Puch]]",
    ]);
  });

  it("keeps an unknown participant as text, unchanged", async () => {
    expect(
      await storedParticipants([
        { name: "Zed Unknown", email: "zed@example.com" },
        { name: "Bo Chen" },
      ]),
    ).toEqual(["Zed Unknown", "Bo Chen"]);
  });
});

describe("person note reads are safe (B264)", () => {
  it("falls back to the base name when the YAML is malformed", async () => {
    pushFiles(fixture, { "people/Cy Dole.md": "---\naliases: [Cy D\n  : : [\n---\n" });
    expect(await storedParticipants([{ name: "Cy Dole" }, { name: "Cy D" }])).toEqual([
      "[[Cy Dole]]",
      "Cy D",
    ]);
  });

  it("reads no aliases from a frontmatter block over the cap", async () => {
    const filler = `note: ${"x".repeat(70 * 1024)}\n`;
    pushFiles(fixture, { "people/Dee Fox.md": `---\n${filler}aliases: [D. Fox]\n---\n` });
    expect(await storedParticipants([{ name: "Dee Fox" }, { name: "D. Fox" }])).toEqual([
      "[[Dee Fox]]",
      "D. Fox",
    ]);
  });

  it("ignores non-string alias values and accepts a plain string", async () => {
    pushFiles(fixture, {
      "people/Eve Gray.md": "---\naliases: [42, true, {a: b}, [E. Gray], '  ']\n---\n",
      "people/Fay Hill.md": "---\naliases: F. Hill\n---\n",
    });
    expect(
      await storedParticipants([{ name: "42" }, { name: "E. Gray" }, { name: "f. hill" }]),
    ).toEqual(["42", "E. Gray", "[[Fay Hill]]"]);
  });

  it("does not follow a symlinked person file", async () => {
    mkdirSync(join(fixture.vaultDir, "people"), { recursive: true });
    const outside = join(fixture.root, "outside-person.md");
    writeFileSync(outside, "---\naliases: [Gus Ito]\n---\n");
    symlinkSync(outside, join(fixture.vaultDir, "people", "Gus.md"));
    expect(await storedParticipants([{ name: "Gus Ito" }, { name: "Gus" }])).toEqual([
      "Gus Ito",
      "Gus",
    ]);
  });

  it("does not execute a ---js fence", async () => {
    const marker = join(fixture.root, "js-ran");
    const note = `---js\n{ aliases: (require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x"), ["Hal J."]) }\n---\n`;
    pushFiles(fixture, { "people/Hal Jay.md": note });
    expect(await storedParticipants([{ name: "Hal Jay" }, { name: "Hal J." }])).toEqual([
      "[[Hal Jay]]",
      "Hal J.",
    ]);
    expect(existsSync(marker)).toBe(false);
  });

  it("drops an alias longer than the field cap", async () => {
    const long = "a".repeat(FIELD_MAX + 1);
    pushFiles(fixture, { "people/Ivy Kim.md": `---\naliases: [${long}, "I. Kim"]\n---\n` });
    expect(await storedParticipants([{ name: long }, { name: "I. Kim" }])).toEqual([
      long,
      "[[Ivy Kim]]",
    ]);
  });

  it("keeps only the first 50 aliases of a note", async () => {
    const aliases = Array.from({ length: 51 }, (_, i) => `Alias ${i}`);
    pushFiles(fixture, { "people/Jo Lee.md": `---\naliases: [${aliases.join(", ")}]\n---\n` });
    expect(await storedParticipants([{ name: "Alias 49" }, { name: "Alias 50" }])).toEqual([
      "[[Jo Lee]]",
      "Alias 50",
    ]);
  });

  it("writes nothing from an alias into the note", async () => {
    pushFiles(fixture, { "people/Kai Moe.md": "---\naliases: [Kaito]\n---\n" });
    const writer = createNoteWriter({
      vaultDir: fixture.vaultDir,
      author: TEST_AUTHOR,
      git: defaultGit,
      log: () => {},
      sleep: () => Promise.resolve(),
    });
    const result = await writer.writeMeeting(meetingInput(46, { people: [{ name: "Kaito" }] }));
    const path = (result as { path: string }).path;
    expect(readFileSync(join(fixture.vaultDir, path), "utf8")).not.toContain("Kaito");
  });
});
