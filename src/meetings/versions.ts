import type { VaultConfig } from "../config/vault-config.js";
import type { MeetingInput } from "./types.js";

// Pure helpers that pick the second version of a meeting (docs/specs/05-meetings, R7). No I/O.

export type VersionCandidate = {
  /** Vault-relative POSIX path. */
  path: string;
  source: MeetingInput["source"];
  start: Date;
  end: Date;
  calendarEvent?: string;
};

export type VersionNote = {
  /** Vault-relative POSIX path. */
  path: string;
  /** Parsed frontmatter. */
  data: Record<string, unknown>;
};

const DAY_MS = 86_400_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The path of the candidate from the other source that is the same meeting, or undefined. A
 * candidate qualifies on the same calendar event id or on an overlap of at least half of the
 * shorter recording. The longest overlap wins; ties go to the smaller path.
 */
export function matchVersion(
  input: MeetingInput,
  eventId: string | undefined,
  candidates: VersionCandidate[],
): string | undefined {
  const inputStart = input.start.getTime();
  const inputEnd = input.end.getTime();
  let best: { path: string; overlap: number } | undefined;
  for (const c of candidates) {
    if (c.source === input.source) continue;
    const cStart = c.start.getTime();
    const cEnd = c.end.getTime();
    const overlap = Math.max(0, Math.min(inputEnd, cEnd) - Math.max(inputStart, cStart));
    const shorter = Math.min(inputEnd - inputStart, cEnd - cStart);
    const sameEvent = eventId !== undefined && c.calendarEvent === eventId;
    if (!sameEvent && !(shorter > 0 && overlap * 2 >= shorter)) continue;
    if (
      best === undefined ||
      overlap > best.overlap ||
      (overlap === best.overlap && c.path < best.path)
    ) {
      best = { path: c.path, overlap };
    }
  }
  return best?.path;
}

function utcDay(value: unknown): number | undefined {
  if (typeof value !== "string" || !DATE_RE.test(value)) return undefined;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(ms) ? undefined : ms;
}

/** True for a non-archived meeting note dated within one day of `newDate` (YYYY-MM-DD). */
export function isVersionCandidate(note: VersionNote, newDate: string, cfg: VaultConfig): boolean {
  const meeting = cfg.types.meeting;
  if (!meeting) return false;
  if (note.data[cfg.properties.type] !== meeting.value) return false;
  const archive = cfg.vault.archive_folder;
  if (note.path === archive || note.path.startsWith(`${archive}/`)) return false;
  const noteDay = utcDay(note.data[cfg.properties.date]);
  const newDay = utcDay(newDate);
  if (noteDay === undefined || newDay === undefined) return false;
  return Math.abs(noteDay - newDay) <= DAY_MS;
}
