import { readdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigInvalidError } from "../src/config/vault-config.js";
import { defaultGit, ensureClone, type GitApi } from "../src/git/index.js";
import { createSourceIndex, type SourceIndex } from "../src/vault/source-index.js";
import { createNoteWriter } from "../src/vault/write-note.js";
import { createGitFixture, type GitFixture, git, TEST_AUTHOR } from "./helpers/git-fixture.js";
import { meetingInput, pushFiles, storedMeeting } from "./helpers/meeting-vault.js";

let fixture: GitFixture;
let logs: string[];

function makeWriter(opts: { git?: Partial<GitApi>; sourceIndex?: SourceIndex } = {}) {
  return createNoteWriter({
    vaultDir: fixture.vaultDir,
    author: TEST_AUTHOR,
    git: { ...defaultGit, ...opts.git },
    sourceIndex: opts.sourceIndex,
    log: (m) => logs.push(m),
    sleep: () => Promise.resolve(),
  });
}

function head(): string {
  return git(fixture.vaultDir, ["rev-parse", "HEAD"]);
}

function listing(): string[] {
  return readdirSync(fixture.vaultDir, { recursive: true, encoding: "utf8" })
    .filter((e) => !e.startsWith(".git"))
    .sort();
}

function skipLines(): string[] {
  return logs.filter((l) => l.includes("meeting_skipped"));
}

beforeEach(async () => {
  fixture = createGitFixture();
  logs = [];
  await ensureClone(fixture.vaultDir, fixture.remote);
});

afterEach(() => {
  vi.restoreAllMocks();
  fixture.cleanup();
});

describe("writeMeeting skips", () => {
  it("exactly min_minutes is too_short and changes nothing", async () => {
    const writer = makeWriter();
    const before = head();
    const files = listing();
    const result = await writer.writeMeeting(meetingInput(5));
    expect(result).toEqual({ ok: true, commit: null, skipped: "too_short" });
    expect(head()).toBe(before);
    expect(git(fixture.vaultDir, ["status", "--porcelain"])).toBe("");
    expect(listing()).toEqual(files);
  });

  it("5:01 is not skipped", async () => {
    pushFiles(fixture, { "work/meetings/a.md": storedMeeting("fireflies:01EXAMPLEID") });
    const result = await makeWriter().writeMeeting(meetingInput(5, {}, 1));
    expect(result).not.toHaveProperty("skipped");
    expect(result).toMatchObject({ already_stored: true });
  });

  it("a custom min_minutes of 0 lets a 1 second recording reach the lookup", async () => {
    pushFiles(fixture, {
      ".2brain/config.yaml": "meetings:\n  min_minutes: 0\n",
      "work/meetings/a.md": storedMeeting("fireflies:01EXAMPLEID"),
    });
    const result = await makeWriter().writeMeeting(meetingInput(0, {}, 1));
    expect(result).toMatchObject({ already_stored: true });
  });

  it("whitespace-only segments are empty_transcript and change nothing", async () => {
    const before = head();
    const files = listing();
    const result = await makeWriter().writeMeeting(
      meetingInput(46, {
        segments: [
          { speaker: "Ana Example", offsetSeconds: 0, text: "  \n\t " },
          { speaker: "", offsetSeconds: 3, text: "" },
        ],
      }),
    );
    expect(result).toEqual({ ok: true, commit: null, skipped: "empty_transcript" });
    expect(head()).toBe(before);
    expect(listing()).toEqual(files);
  });

  it("one segment with text is not empty", async () => {
    const result = await makeWriter().writeMeeting(meetingInput(46));
    expect(result).toMatchObject({ ok: true, path: expect.stringMatching(/\.md$/u) });
    expect(result).not.toHaveProperty("skipped");
    expect(typeof (result as { commit: unknown }).commit).toBe("string");
  });

  it("each skip logs exactly one line with the source and reason and no input text", async () => {
    const marker = "ZQXMARKER";
    const planted = {
      sourceTitle: `Title ${marker}`,
      people: [{ name: `Name ${marker}`, email: `${marker.toLowerCase()}@example.com` }],
      segments: [{ speaker: `Who ${marker}`, offsetSeconds: 0, text: `Said ${marker}` }],
    };
    const writer = makeWriter();
    await writer.writeMeeting(meetingInput(2, planted));
    expect(skipLines()).toEqual(["meeting_skipped: source=fireflies reason=too_short"]);

    logs.length = 0;
    await writer.writeMeeting(
      meetingInput(46, {
        ...planted,
        source: "gemini",
        segments: [{ speaker: `Who ${marker}`, offsetSeconds: 0, text: "  " }],
      }),
    );
    expect(skipLines()).toEqual(["meeting_skipped: source=gemini reason=empty_transcript"]);
    expect(logs.join("\n")).not.toContain(marker);
  });

  it("a 4 MiB single-segment transcript passes normalization and the skips in a few seconds", async () => {
    pushFiles(fixture, { "work/meetings/a.md": storedMeeting("fireflies:01EXAMPLEID") });
    const text = `${"lorem ipsum dolor sit amet ".repeat(160_000)}`.slice(0, 4 * 1024 * 1024);
    const started = Date.now();
    const result = await makeWriter().writeMeeting(
      meetingInput(46, { segments: [{ speaker: "Ana Example", offsetSeconds: 0, text }] }),
    );
    expect(result).toMatchObject({ already_stored: true });
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe("writeMeeting queue and config", () => {
  it("does not start its pull until an earlier write has finished", async () => {
    const events: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    let pulls = 0;
    const writer = makeWriter({
      git: {
        pullRebase: async (...args) => {
          pulls += 1;
          events.push(`pull${pulls}`);
          if (pulls === 1) await gate;
          return defaultGit.pullRebase(...args);
        },
        commitFile: (...args) => {
          events.push("commit");
          return defaultGit.commitFile(...args);
        },
      },
    });
    const note = writer.write({
      path: "inbox/a.md",
      frontmatter: { type: "idea", area: "personal", date: "2026-10-31", source: "manual" },
      body: "x\n",
    });
    const meeting = writer.writeMeeting(meetingInput(2));
    for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 5));
    expect(pulls).toBe(1);
    release();
    await Promise.all([note, meeting]);
    expect(events).toEqual(["pull1", "commit", "pull2"]);
  });

  it("a missing meeting type throws ConfigInvalidError and never reads the source index", async () => {
    pushFiles(fixture, { ".2brain/config.yaml": "types:\n  scrap:\n    value: scrap-note\n" });
    const real = createSourceIndex();
    const lookup = vi.fn(real.lookup);
    const writer = makeWriter({ sourceIndex: { lookup } });
    const error = await writer.writeMeeting(meetingInput(46)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigInvalidError);
    expect((error as ConfigInvalidError).keyPath).toBe("types.meeting");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("the skips run before the source lookup", async () => {
    pushFiles(fixture, { "work/meetings/a.md": storedMeeting("fireflies:01EXAMPLEID") });
    const lookup = vi.fn(createSourceIndex().lookup);
    const writer = makeWriter({ sourceIndex: { lookup } });
    expect(await writer.writeMeeting(meetingInput(2))).toEqual({
      ok: true,
      commit: null,
      skipped: "too_short",
    });
    expect(
      await writer.writeMeeting(
        meetingInput(46, { segments: [{ speaker: "Ana Example", offsetSeconds: 0, text: " " }] }),
      ),
    ).toEqual({ ok: true, commit: null, skipped: "empty_transcript" });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("the meeting setup is checked before the skips", async () => {
    pushFiles(fixture, { ".2brain/config.yaml": "types:\n  scrap:\n    value: scrap-note\n" });
    const error = await makeWriter()
      .writeMeeting(meetingInput(2))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigInvalidError);
    expect(skipLines()).toEqual([]);
  });
});
