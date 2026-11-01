import type { Dirent } from "node:fs";
import { readdir, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { requireMeetingSetup, type VaultConfig } from "../config/vault-config.js";
import type { GitApi } from "../git/index.js";
import { routeArea } from "../meetings/area.js";
import { pickEvent } from "../meetings/calendar.js";
import { meetingFrontmatter } from "../meetings/frontmatter.js";
import { meetingPath } from "../meetings/name.js";
import { normalizeSegments } from "../meetings/normalize.js";
import type { MeetingInput, MeetingOk } from "../meetings/types.js";
import { stringifyNote } from "./frontmatter.js";
import { type Scrubber, scrubNote } from "./scrub-note.js";
import type { SourceIndex } from "./source-index.js";
import { type FrontmatterVerdict, validateFrontmatter } from "./validate.js";

export interface MeetingWriterDeps {
  root: string;
  git: Pick<GitApi, "headSha">;
  sourceIndex: SourceIndex;
  log: (message: string) => void;
  /** Pull and read the vault config as it is after the pull. Runs inside the write slot. */
  syncAndLoadConfig: () => Promise<VaultConfig>;
  scrubber: Scrubber;
  /** Refuse a path that matches a scrub rule (`UnsafePathError`). */
  refuseSecretPath: (path: string) => void;
  /** Throw the error that maps a failed validation verdict. */
  rejectInvalid: (verdict: Exclude<FrontmatterVerdict, { ok: true }>) => never;
  /** Create the file, commit it with the message, push; returns the commit. */
  createMeetingNote: (path: string, bytes: string, message: string) => Promise<string>;
}

/**
 * Base names (no `.md`) of the regular files directly inside the person folders of the vault. The
 * listing is names only: no file is read, a symlink is skipped, and a folder whose real location
 * is outside the vault is skipped. A missing folder gives nothing.
 */
async function listPersons(root: string, cfg: VaultConfig): Promise<string[]> {
  const template = cfg.types.person?.folder;
  if (template === undefined) return [];
  const folders = new Set(
    template.includes("{area}")
      ? cfg.areas.map((a) => template.replaceAll("{area}", a))
      : [template],
  );
  const realRoot = await realpath(root);
  const names = new Set<string>();
  for (const folder of folders) {
    const dir = resolve(root, folder);
    if (dir !== root && !dir.startsWith(root + sep)) continue;
    let entries: Dirent[];
    try {
      const real = await realpath(dir);
      if (real !== realRoot && !real.startsWith(realRoot + sep)) continue;
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".md")) names.add(entry.name.slice(0, -3));
    }
  }
  return [...names].sort();
}

/**
 * The meeting write, run inside the writer's queue slot. Order: pull and load the config, check
 * the meeting setup, skip short or empty recordings, look the source id up, and for a new one: pick
 * the calendar event, route the area, build the path (refused when it matches a scrub rule), list
 * the person base names, build the frontmatter, scrub once, validate the scrubbed result once,
 * create the file, commit `2brain: add meeting <path>` and push. The log line of a skip holds only
 * the source and the reason, never a title, a name or transcript text.
 */
export async function writeMeetingInSlot(
  input: MeetingInput,
  deps: MeetingWriterDeps,
): Promise<MeetingOk> {
  const cfg = await deps.syncAndLoadConfig();
  requireMeetingSetup(cfg);

  const skip = (reason: "too_short" | "empty_transcript"): MeetingOk => {
    deps.log(`meeting_skipped: source=${input.source} reason=${reason}`);
    return { ok: true, commit: null, skipped: reason };
  };

  if (input.end.getTime() - input.start.getTime() <= cfg.meetings.min_minutes * 60_000) {
    return skip("too_short");
  }
  const { body, turns } = normalizeSegments(input.segments, cfg.meetings.unknown_speaker_label);
  if (turns === 0) return skip("empty_transcript");

  const id = `${cfg.meetings.sources[input.source].value}:${input.sourceId}`;
  const head = await deps.git.headSha(deps.root);
  const found = await deps.sourceIndex.lookup(deps.root, head, cfg.properties.source_id, id);
  if (found !== undefined) return { ok: true, path: found, commit: null, already_stored: true };

  const event = pickEvent(input.calendarEvents, input.start, input.end);
  const area = routeArea(event, input, cfg);
  const { path } = meetingPath(event, input.start, area, cfg);
  deps.refuseSecretPath(path);

  const persons = await listPersons(deps.root, cfg);
  const frontmatter = meetingFrontmatter(input, { event, area }, cfg, persons);
  const scrubbed = scrubNote(deps.scrubber, frontmatter, body);
  const verdict = validateFrontmatter(scrubbed.frontmatter, path, cfg);
  if (!verdict.ok) deps.rejectInvalid(verdict);

  const bytes = stringifyNote(scrubbed.frontmatter, scrubbed.body);
  const commit = await deps.createMeetingNote(path, bytes, `2brain: add meeting ${path}`);
  return scrubbed.redactions.length > 0
    ? { ok: true, path, commit, redactions: scrubbed.redactions }
    : { ok: true, path, commit };
}
