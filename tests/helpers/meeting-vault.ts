import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { MeetingInput } from "../../src/meetings/types.js";
import { type GitFixture, git } from "./git-fixture.js";

let counter = 0;

/** Commit and push files from a second clone; returns the pushed sha. */
export function pushFiles(fixture: GitFixture, files: Record<string, string>): string {
  counter += 1;
  const dir = fixture.cloneElsewhere(`meeting-seed-${counter}`);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
    git(dir, ["add", path]);
  }
  git(dir, ["commit", "-m", "seed files"]);
  git(dir, ["push", "origin", "main"]);
  return git(dir, ["rev-parse", "HEAD"]);
}

/** A stored meeting note holding `sourceId` as its `source_id`. */
export function storedMeeting(sourceId: string, source = "fireflies"): string {
  return [
    "---",
    "type: meeting",
    "area: work",
    "date: 2026-10-30",
    `source: ${source}`,
    `source_id: ${sourceId}`,
    "---",
    "",
    "**Ana Example** [00:00:00]",
    "Hello.",
    "",
  ].join("\n");
}

/** A meeting input of `minutes` minutes with one spoken segment, fictional people only. */
export function meetingInput(
  minutes: number,
  overrides: Partial<MeetingInput> = {},
  extraSeconds = 0,
): MeetingInput {
  const start = new Date("2026-10-30T15:00:00Z");
  return {
    source: "fireflies",
    sourceId: "01EXAMPLEID",
    start,
    end: new Date(start.getTime() + (minutes * 60 + extraSeconds) * 1000),
    sourceTitle: "Weekly sync",
    people: [{ name: "Ana Example", email: "ana@example.com" }],
    segments: [{ speaker: "Ana Example", offsetSeconds: 0, text: "Hello there." }],
    calendarEvents: [],
    ...overrides,
  };
}
