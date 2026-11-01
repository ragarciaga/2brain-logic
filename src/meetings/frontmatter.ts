import { CONFIG_FILE, ConfigInvalidError, type VaultConfig } from "../config/vault-config.js";
import type { CalendarEvent, MeetingInput } from "./types.js";

/** Longest optional string written to a meeting's frontmatter, in code points. */
export const FIELD_MAX = 1000;

/** What the area router and calendar picker chose for one meeting. */
export type MeetingChoice = { event?: CalendarEvent; area: string };

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

type Local = { date: string; iso: string };

/** Wall-clock date and ISO 8601 time with the zone offset, for an instant in an IANA zone. */
function localTime(instant: Date, timeZone: string): Local {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts: Record<string, number> = {};
  for (const part of formatter.formatToParts(instant)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  const year = parts.year ?? 0;
  const month = parts.month ?? 0;
  const day = parts.day ?? 0;
  const hour = parts.hour ?? 0;
  const minute = parts.minute ?? 0;
  const second = parts.second ?? 0;
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const instantSeconds = Math.floor(instant.getTime() / 1000) * 1000;
  const offsetMinutes = Math.round((wallAsUtc - instantSeconds) / 60000);
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  const offset = `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  const date = `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
  return { date, iso: `${date}T${pad(hour)}:${pad(minute)}:${pad(second)}${offset}` };
}

function key(value: string): string {
  return value.normalize("NFC").trim().toLowerCase();
}

function participants(people: MeetingInput["people"], persons: readonly string[]): string[] {
  const bases = new Map<string, string>();
  for (const base of persons) bases.set(key(base), base);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const person of people) {
    const name = person.name?.trim() ?? "";
    const email = person.email?.trim() ?? "";
    if (name === "" && email === "") continue;
    const nameKey = name === "" ? "" : key(name);
    const emailKey = email === "" ? "" : key(email);
    if (emailKey !== "" ? seen.has(emailKey) : seen.has(nameKey)) continue;
    if (emailKey !== "") seen.add(emailKey);
    if (nameKey !== "") seen.add(nameKey);
    const base = nameKey === "" ? undefined : bases.get(nameKey);
    out.push(base !== undefined ? `[[${base}]]` : name !== "" ? name : email);
  }
  return out;
}

/** The parsed https href without userinfo, or undefined when it cannot be stored. */
function cleanUrl(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:") return undefined;
  url.username = "";
  url.password = "";
  const href = url.href;
  return Array.from(href).length > FIELD_MAX ? undefined : href;
}

/**
 * Frontmatter of a meeting note, in the design order: the canonical keys under the owner's names,
 * then the meeting keys under the configured names. Absent values are left out, never null.
 * `versions` is added by the writer (`writeMeetingInSlot`) when it links a second version.
 */
export function meetingFrontmatter(
  input: MeetingInput,
  choice: MeetingChoice,
  cfg: VaultConfig,
  persons: readonly string[],
): Record<string, unknown> {
  const type = cfg.types.meeting?.value;
  if (type === undefined) {
    throw new ConfigInvalidError(
      CONFIG_FILE,
      "types.meeting",
      "the meeting type is not configured",
    );
  }
  const { properties: owner } = cfg;
  const names = cfg.meetings.properties;
  const zone = cfg.meetings.timezone;
  const start = localTime(input.start, zone);
  const end = localTime(input.end, zone);
  const sourceValue = cfg.meetings.sources[input.source].value;

  const entries: [string, unknown][] = [
    [owner.type, type],
    [owner.area, choice.area],
    [owner.date, start.date],
    [owner.source, sourceValue],
    [owner.source_id, `${sourceValue}:${input.sourceId}`],
    [names.start, start.iso],
    [names.end, end.iso],
    [names.duration, Math.floor((input.end.getTime() - input.start.getTime()) / 60000)],
  ];

  const people = participants(input.people, persons);
  if (people.length > 0) entries.push([names.participants, people]);

  const eventId = choice.event?.id;
  if (eventId !== undefined && eventId.trim() !== "" && Array.from(eventId).length <= FIELD_MAX) {
    entries.push([names.calendar_event, eventId]);
  }

  const title = input.sourceTitle;
  if (title !== undefined && title.trim() !== "") {
    entries.push([names.source_title, Array.from(title).slice(0, FIELD_MAX).join("")]);
  }

  const url = cleanUrl(input.sourceUrl);
  if (url !== undefined) entries.push([names.source_url, url]);

  // fromEntries defines own keys, so an owner property named `__proto__` stays a plain key.
  return Object.fromEntries(entries);
}
