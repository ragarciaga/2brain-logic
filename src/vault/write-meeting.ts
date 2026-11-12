import type { Dirent, Stats } from "node:fs";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { posix, resolve, sep } from "node:path";
import { requireMeetingSetup, type VaultConfig } from "../config/vault-config.js";
import type { GitApi } from "../git/index.js";
import { trackedAtHead } from "../git/sync.js";
import { routeArea } from "../meetings/area.js";
import { pickEvent } from "../meetings/calendar.js";
import { FIELD_MAX, meetingFrontmatter, type PersonNote } from "../meetings/frontmatter.js";
import { localParts, meetingFolder, meetingPath, withTimeSuffix } from "../meetings/name.js";
import { normalizeSegments } from "../meetings/normalize.js";
import type { MeetingInput, MeetingOk } from "../meetings/types.js";
import { isVersionCandidate, matchVersion, type VersionCandidate } from "../meetings/versions.js";
import { parseNote, stringifyNote } from "./frontmatter.js";
import { NotePath } from "./note-schema.js";
import { mergeProperties, readStoredNote } from "./operations.js";
import { type Scrubber, scrubNote } from "./scrub-note.js";
import { readFrontmatterBlock, type SourceIndex, SourceIndexLimitError } from "./source-index.js";
import { type FrontmatterVerdict, validateFrontmatter } from "./validate.js";
import { InvalidFrontmatterError, NoteExistsError, UnsafePathError } from "./write-note.js";

/** The other version of a meeting, rewritten in the same commit as the new note. */
export interface MeetingLink {
  path: string;
  /** The other note's new bytes: its stored body and its frontmatter with `versions` set. */
  bytes: string;
  /** The bytes read before; rollback writes them back and a changed file is refused. */
  original: Buffer;
}

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
  /**
   * Run for a note that already holds the source id: refuse one that HEAD does not track
   * (`NoteExistsError`), push a commit waiting locally, and throw `PushPendingError` when the
   * push does not land.
   */
  deliverStored: (path: string) => Promise<void>;
  /**
   * Create the file, commit it with the message (together with `link`, when given), push; returns
   * the commit.
   */
  createMeetingNote: (
    path: string,
    bytes: string,
    message: string,
    link?: MeetingLink,
  ) => Promise<string>;
}

const MAX_CANDIDATE_FILES = 20_000;
const CANDIDATE_FRONTMATTER_CAP = 64 * 1024;

/** Characters that would end or split an Obsidian wikilink. */
const WIKILINK_BREAKERS = /[[\]|#^]/u;

/**
 * Meeting notes that may be the other version of a meeting dated `newDate`: regular `.md` files
 * directly inside a meeting folder, whose frontmatter is read (block only). A candidate is a
 * non-archived meeting note within a day of the date, stored in the folder of its own area, from a
 * configured source, with readable start and end, and with no `versions` yet. Symlinks and folders
 * that leave the vault are skipped; a parse error skips the file. Only a note tracked at HEAD
 * counts: an untracked file (a crash leftover) is never linked or committed.
 */
async function listVersionCandidates(
  root: string,
  cfg: VaultConfig,
  newDate: string,
): Promise<{ candidates: VersionCandidate[]; areas: Map<string, string> }> {
  const candidates: VersionCandidate[] = [];
  const areas = new Map<string, string>();
  const owner = cfg.properties;
  const names = cfg.meetings.properties;
  const sources = new Map<string, "fireflies" | "gemini">([
    [cfg.meetings.sources.fireflies.value, "fireflies"],
    [cfg.meetings.sources.gemini.value, "gemini"],
  ]);
  const folders = new Set(cfg.areas.map((area) => meetingFolder(cfg, area)));
  const realRoot = await realpath(root);
  let files = 0;
  for (const folder of folders) {
    const dir = resolve(root, folder);
    if (!dir.startsWith(root + sep)) continue;
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
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      files += 1;
      if (files > MAX_CANDIDATE_FILES) throw new SourceIndexLimitError();
      const path = `${folder}/${entry.name}`;
      let data: Record<string, unknown>;
      try {
        const block = await readFrontmatterBlock(
          resolve(dir, entry.name),
          CANDIDATE_FRONTMATTER_CAP,
        );
        if (block === undefined) continue;
        data = parseNote(block).data;
      } catch {
        continue;
      }
      if (typeof data !== "object" || data === null || Array.isArray(data)) continue;
      if (!isVersionCandidate({ path, data }, newDate, cfg)) continue;
      const own = (key: string): unknown => (Object.hasOwn(data, key) ? data[key] : undefined);
      const area = own(owner.area);
      if (typeof area !== "string" || !cfg.areas.includes(area)) continue;
      if (meetingFolder(cfg, area) !== folder) continue;
      const versions = own(names.versions);
      if (versions !== undefined && !(Array.isArray(versions) && versions.length === 0)) continue;
      const sourceValue = own(owner.source);
      const source = typeof sourceValue === "string" ? sources.get(sourceValue) : undefined;
      if (source === undefined) continue;
      const startText = own(names.start);
      const endText = own(names.end);
      if (typeof startText !== "string" || typeof endText !== "string") continue;
      const start = new Date(Date.parse(startText));
      const end = new Date(Date.parse(endText));
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;
      const calendarEvent = own(names.calendar_event);
      if (!(await trackedAtHead(root, path))) continue;
      candidates.push({
        path,
        source,
        start,
        end,
        ...(typeof calendarEvent === "string" ? { calendarEvent } : {}),
      });
      areas.set(path, area);
    }
  }
  return { candidates, areas };
}

/** `NotePath` and the scrub rules on a meeting path, before any file work. */
function assertMeetingPath(path: string, deps: MeetingWriterDeps): void {
  if (!NotePath.safeParse(path).success) throw new UnsafePathError();
  deps.refuseSecretPath(path);
}

/**
 * What sits at the vault-relative path: nothing (`free`), a regular file that HEAD does not track
 * and whose bytes equal `bytes` (`same`: the file of a write that crashed before its commit), or
 * anything else, a symlink included (`taken`).
 */
async function occupancy(
  root: string,
  path: string,
  bytes: string,
): Promise<"free" | "same" | "taken"> {
  const target = resolve(root, path);
  let info: Stats;
  try {
    info = await lstat(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return "free";
    throw error;
  }
  if (!info.isFile() || info.size !== Buffer.byteLength(bytes)) return "taken";
  if (!(await readFile(target)).equals(Buffer.from(bytes))) return "taken";
  return (await trackedAtHead(root, path)) ? "taken" : "same";
}

const MAX_PERSON_READS = 2000;
const PERSON_FRONTMATTER_CAP = 64 * 1024;
const MAX_ALIASES = 50;

/** The usable `aliases` of a parsed frontmatter: trimmed, non-empty strings within the cap. */
function aliasesOf(data: unknown): string[] {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return [];
  if (!Object.hasOwn(data, "aliases")) return [];
  const raw: unknown = (data as Record<string, unknown>).aliases;
  const items: unknown[] = Array.isArray(raw) ? raw : [raw];
  const out: string[] = [];
  for (const item of items) {
    if (typeof item !== "string") continue;
    const text = item.trim();
    if (text === "" || Array.from(text).length > FIELD_MAX) continue;
    out.push(text);
    if (out.length >= MAX_ALIASES) break;
  }
  return out;
}

/**
 * The regular files directly inside the person folders of the vault, as their base name (no `.md`)
 * and the `aliases` of their frontmatter. Only the frontmatter block is read (at most 64 KiB, for
 * at most 2,000 notes) through the safe parser; a symlink is skipped, and a folder whose real
 * location is outside the vault is skipped. A note that cannot be read or parsed contributes its
 * base name only. A missing folder gives nothing.
 */
async function listPersons(root: string, cfg: VaultConfig): Promise<PersonNote[]> {
  const template = cfg.types.person?.folder;
  if (template === undefined) return [];
  const folders = new Set(
    template.includes("{area}")
      ? cfg.areas.map((a) => template.replaceAll("{area}", a))
      : [template],
  );
  const realRoot = await realpath(root);
  const found = new Map<string, Set<string>>();
  let reads = 0;
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
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const base = entry.name.slice(0, -3);
      const aliases = found.get(base) ?? new Set<string>();
      found.set(base, aliases);
      if (reads >= MAX_PERSON_READS) continue;
      reads += 1;
      try {
        const block = await readFrontmatterBlock(resolve(dir, entry.name), PERSON_FRONTMATTER_CAP);
        if (block === undefined) continue;
        for (const alias of aliasesOf(parseNote(block).data)) aliases.add(alias);
      } catch {
        // unreadable or malformed: the base name alone
      }
    }
  }
  return [...found.keys()].sort().map((base) => ({ base, aliases: [...(found.get(base) ?? [])] }));
}

/**
 * The meeting write, run inside the writer's queue slot. Order: pull and load the config, check
 * the meeting setup, skip short or empty recordings, look the source id up (a known id answers
 * `already_stored` for a note tracked at HEAD, after pushing a waiting commit; `PushPendingError`
 * when it does not land), and for a new one, or one whose holder HEAD does not track: pick
 * the calendar event, route the area, then look for the other version of the meeting among the
 * stored meeting notes (`matchVersion`: same calendar event or enough overlap, other source, no
 * `versions` yet). With a match the new note is `<other base> (<source label>).md` in the other
 * note's folder and area, its `versions` holds a wikilink to the other note, and the other note's
 * frontmatter (only) gets the reverse link; both are committed together as
 * `2brain: add meeting <path> (version of <other path>)`, the result has `linked: <other path>`,
 * and if the commit fails both go back. Without a match the path is `<date> · <title>.md`; if
 * another note holds it, ` HH-MM` is added, and if that is taken too the answer is
 * `NoteExistsError`. Every path passes `NotePath` and the scrub rules before any file work
 * (`UnsafePathError`). The person notes (base names and aliases) are listed and the frontmatter is built and scrubbed
 * once before a path is taken, because a path that holds a regular file HEAD does not track with
 * exactly these bytes (a write that crashed before its commit) is not taken: that file is adopted
 * and committed. An untracked holder of the source id at any other path stays `NoteExistsError`.
 * Then: validate the scrubbed result once, create the file, commit `2brain: add meeting <path>`
 * and push. A merged frontmatter of the other note that fails validation rejects the request and
 * writes nothing. The log line of a skip holds only the source and the reason, never a title, a
 * name or transcript text.
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
  // A holder that HEAD does not track may be the file of a write that crashed before its commit:
  // it is adopted below only when it sits at the path this write picks, with identical bytes.
  let leftover: string | undefined;
  if (found !== undefined) {
    if (await trackedAtHead(deps.root, found)) {
      await deps.deliverStored(found);
      return { ok: true, path: found, commit: null, already_stored: true };
    }
    leftover = found;
  }

  const event = pickEvent(input.calendarEvents, input.start, input.end);
  const routedArea = routeArea(event, input, cfg);

  const newDate = localParts(input.start, cfg.meetings.timezone).date;
  const { candidates, areas } = await listVersionCandidates(deps.root, cfg, newDate);
  const other = matchVersion(input, event?.id, candidates);

  let versionPath: string | undefined;
  let area = routedArea;
  let otherBase = "";
  if (other !== undefined) {
    area = areas.get(other) ?? routedArea;
    otherBase = posix.basename(other, ".md");
    versionPath = `${posix.dirname(other)}/${otherBase} (${cfg.meetings.sources[input.source].label}).md`;
    assertMeetingPath(versionPath, deps);
    if (
      WIKILINK_BREAKERS.test(posix.basename(versionPath, ".md")) ||
      WIKILINK_BREAKERS.test(otherBase)
    ) {
      throw new UnsafePathError();
    }
  }
  const planned = other === undefined ? meetingPath(event, input.start, area, cfg) : undefined;
  if (planned !== undefined) assertMeetingPath(planned.path, deps);

  const persons = await listPersons(deps.root, cfg);
  const frontmatter = meetingFrontmatter(input, { event, area }, cfg, persons);
  if (other !== undefined) {
    Object.defineProperty(frontmatter, cfg.meetings.properties.versions, {
      value: [`[[${otherBase}]]`],
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  const scrubbed = scrubNote(deps.scrubber, frontmatter, body);
  const bytes = stringifyNote(scrubbed.frontmatter, scrubbed.body);

  let path: string;
  if (versionPath !== undefined) {
    path = versionPath;
    if ((await occupancy(deps.root, path, bytes)) === "taken") throw new NoteExistsError();
  } else if (planned !== undefined) {
    path = planned.path;
    if ((await occupancy(deps.root, path, bytes)) === "taken") {
      path = `${planned.folder}/${withTimeSuffix(planned.base, input.start, cfg)}.md`;
      assertMeetingPath(path, deps);
      if ((await occupancy(deps.root, path, bytes)) === "taken") throw new NoteExistsError();
    }
  } else {
    throw new Error("no meeting path");
  }
  // Another file holds the source id: this is not its retry.
  if (leftover !== undefined && leftover !== path) throw new NoteExistsError();

  const newBase = posix.basename(path, ".md");
  const verdict = validateFrontmatter(scrubbed.frontmatter, path, cfg);
  if (!verdict.ok) deps.rejectInvalid(verdict);

  let link: MeetingLink | undefined;
  if (other !== undefined) {
    const original = await readFile(resolve(deps.root, other));
    const stored = readStoredNote(original);
    if (stored === undefined) throw new InvalidFrontmatterError([], []);
    const merged = mergeProperties(stored.data, {
      [cfg.meetings.properties.versions]: [`[[${newBase}]]`],
    });
    const otherVerdict = validateFrontmatter(merged, other, cfg);
    if (!otherVerdict.ok) deps.rejectInvalid(otherVerdict);
    const otherBytes = stringifyNote(merged, stored.body);
    if (readStoredNote(Buffer.from(otherBytes))?.body !== stored.body) {
      throw new Error("the other version's body would change");
    }
    link = { path: other, bytes: otherBytes, original };
  }

  const message =
    other === undefined
      ? `2brain: add meeting ${path}`
      : `2brain: add meeting ${path} (version of ${other})`;
  const commit = await deps.createMeetingNote(path, bytes, message, link);
  const linkedPart = other === undefined ? {} : { linked: other };
  return scrubbed.redactions.length > 0
    ? { ok: true, path, commit, ...linkedPart, redactions: scrubbed.redactions }
    : { ok: true, path, commit, ...linkedPart };
}
