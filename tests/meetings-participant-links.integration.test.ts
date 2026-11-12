import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultGit, ensureClone } from "../src/git/index.js";
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
