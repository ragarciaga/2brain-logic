import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultGit, ensureClone } from "../src/git/index.js";
import { createNoteWriter } from "../src/vault/write-note.js";
import { createGitFixture, type GitFixture, git, TEST_AUTHOR } from "./helpers/git-fixture.js";
import { meetingInput, pushFiles, storedMeeting } from "./helpers/meeting-vault.js";

const PATH = "work/meetings/2026-10-30 · Weekly sync.md";

let fixture: GitFixture;

function makeWriter() {
  return createNoteWriter({
    vaultDir: fixture.vaultDir,
    author: TEST_AUTHOR,
    git: defaultGit,
    log: () => undefined,
    sleep: () => Promise.resolve(),
  });
}

beforeEach(async () => {
  fixture = createGitFixture();
  await ensureClone(fixture.vaultDir, fixture.remote);
});

afterEach(() => {
  fixture.cleanup();
});

describe("meeting redelivery", () => {
  it("answers already_stored with no commit, no change and no dirty tree", async () => {
    const seeded = pushFiles(fixture, { [PATH]: storedMeeting("fireflies:01EXAMPLEID") });
    const result = await makeWriter().writeMeeting(meetingInput(46));
    expect(result).toEqual({ ok: true, path: PATH, commit: null, already_stored: true });
    const bytes = readFileSync(join(fixture.vaultDir, PATH), "utf8");
    expect(bytes).toBe(storedMeeting("fireflies:01EXAMPLEID"));
    expect(git(fixture.vaultDir, ["rev-parse", "HEAD"])).toBe(seeded);
    expect(git(fixture.remote, ["rev-parse", "main"])).toBe(seeded);
    expect(git(fixture.vaultDir, ["status", "--porcelain"])).toBe("");
  });

  it("another source id is stored at a new path", async () => {
    pushFiles(fixture, { [PATH]: storedMeeting("fireflies:01EXAMPLEID") });
    const result = await makeWriter().writeMeeting(meetingInput(46, { source: "gemini" }));
    expect(result).toMatchObject({ ok: true, commit: expect.any(String) });
    expect((result as { path: string }).path).not.toBe(PATH);
  });

  it("matches a renamed source value", async () => {
    pushFiles(fixture, {
      ".2brain/config.yaml":
        "meetings:\n  sources:\n    fireflies:\n      value: ff\n      label: Fireflies\n",
      [PATH]: storedMeeting("ff:01EXAMPLEID", "ff"),
    });
    const result = await makeWriter().writeMeeting(meetingInput(46));
    expect(result).toMatchObject({ already_stored: true, path: PATH });
  });
});
