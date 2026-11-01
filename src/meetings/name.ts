import { DEFAULT_VAULT_CONFIG } from "../config/defaults.js";
import { CONFIG_FILE, ConfigInvalidError, type VaultConfig } from "../config/vault-config.js";
import { scrub } from "../vault/scrub/index.js";
import type { CalendarEvent } from "./types.js";

// Names a meeting note: `<folder>/YYYY-MM-DD · <title>.md` (docs/specs/05-meetings/design.md).
// Pure: the event and the area arrive as plain values. The title is external input, so it is
// cleaned and scrubbed here; the writer's NotePath and path-secret checks still run later.

const MAX_PATH = 255;
const DATE_PREFIX_LENGTH = "YYYY-MM-DD · ".length;
const EXTENSION_LENGTH = ".md".length;
const TIME_SUFFIX_LENGTH = " HH-MM".length;
const LABEL_SUFFIX_OVERHEAD = " ()".length;

// Characters that are unsafe in a file name or break Obsidian links, plus control characters.
// biome-ignore lint/suspicious/noControlCharactersInRegex: replacing control characters is the point
const FORBIDDEN_RUN = /[<>:"/\\|?*[\]#^\u0000-\u001f\u007f]+/gu;

export function localParts(start: Date, timeZone: string): { date: string; hhmm: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(start);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    hhmm: `${get("hour")}-${get("minute")}`,
  };
}

function trimEdges(text: string): string {
  return text.replace(/^[ .]+|[ .]+$/gu, "");
}

/** Make external text safe as part of a file name. */
export function cleanTitle(raw: string): string {
  return trimEdges(raw.normalize("NFC").replace(FORBIDDEN_RUN, " ").replace(/\s+/gu, " "));
}

function cut(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  let out = "";
  for (const ch of Array.from(text)) {
    if (out.length + ch.length > maxLen) break;
    out += ch;
  }
  return trimEdges(out);
}

function scrubHit(text: string): boolean {
  return scrub(text).hits.size > 0;
}

/** A cleaned, cut text that is non-empty and not a scrub hit (raw or cleaned), else "". */
function safeText(raw: string, maxLen: number): string {
  const cleaned = cut(cleanTitle(raw), maxLen);
  if (cleaned === "" || scrubHit(raw) || scrubHit(cleaned)) return "";
  return cleaned;
}

/**
 * The title part of the base name: the cleaned event title, or the untitled label plus the
 * local `HH-MM` when there is no usable title.
 */
export function meetingTitle(
  event: CalendarEvent | undefined,
  start: Date,
  cfg: VaultConfig,
  maxLen: number,
): string {
  if (event?.title !== undefined) {
    const title = safeText(event.title, maxLen);
    if (title !== "") return title;
  }
  const labelMax = Math.max(maxLen - TIME_SUFFIX_LENGTH, 0);
  const label =
    safeText(cfg.meetings.untitled_label, labelMax) ||
    safeText(DEFAULT_VAULT_CONFIG.meetings.untitled_label, Number.MAX_SAFE_INTEGER);
  return `${label} ${localParts(start, cfg.meetings.timezone).hhmm}`;
}

/** The meeting type's folder with `{area}` replaced. */
export function meetingFolder(cfg: VaultConfig, area: string): string {
  const folder = cfg.types.meeting?.folder;
  if (folder === undefined) {
    throw new ConfigInvalidError(
      CONFIG_FILE,
      "types.meeting",
      "meetings need a meeting type with a folder",
    );
  }
  if (!cfg.areas.includes(area)) {
    throw new Error(`"${area}" is not one of the configured areas`);
  }
  return folder.replaceAll("{area}", area);
}

/**
 * Folder, base name (no extension) and path of a meeting note. Room is kept for the collision
 * suffixes ` HH-MM` and ` (<source label>)` so the final path stays within 255 characters.
 */
export function meetingPath(
  event: CalendarEvent | undefined,
  start: Date,
  area: string,
  cfg: VaultConfig,
): { folder: string; base: string; path: string } {
  const folder = meetingFolder(cfg, area);
  const labelLengths = Object.values(cfg.meetings.sources).map((s) => s.label.length);
  const reserve = TIME_SUFFIX_LENGTH + LABEL_SUFFIX_OVERHEAD + Math.max(0, ...labelLengths);
  const maxLen = MAX_PATH - folder.length - 1 - DATE_PREFIX_LENGTH - EXTENSION_LENGTH - reserve;
  const { date } = localParts(start, cfg.meetings.timezone);
  const base = `${date} · ${meetingTitle(event, start, cfg, maxLen)}`;
  return { folder, base, path: `${folder}/${base}.md` };
}

/** `base + " HH-MM"` in the configured zone. */
export function withTimeSuffix(base: string, start: Date, cfg: VaultConfig): string {
  return `${base} ${localParts(start, cfg.meetings.timezone).hhmm}`;
}
