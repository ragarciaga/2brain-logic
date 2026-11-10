import type { VaultConfig } from "../config/vault-config.js";
import type { CalendarEvent, MeetingInput } from "./types.js";

// Pure area router for a meeting (docs/specs/05-meetings, R5.1 and R5.2). No I/O.

function domainOf(email: string | undefined): string | undefined {
  if (email === undefined) return undefined;
  const at = email.lastIndexOf("@");
  if (at < 0) return undefined;
  const domain = email
    .slice(at + 1)
    .trim()
    .toLowerCase();
  return domain === "" ? undefined : domain;
}

/** True when the title starts with the prefix, ignoring case and leading spaces. */
export function hasTitlePrefix(title: string | undefined, prefix: string): boolean {
  if (title === undefined) return false;
  return title
    .normalize("NFC")
    .trimStart()
    .toLowerCase()
    .startsWith(prefix.normalize("NFC").toLowerCase());
}

/**
 * The event title without the first `title_prefix` of `meetings.area_rules` it starts with, so a
 * calendar that tags titles (`BFA · Weekly`) still names the note after the meeting. A title
 * that is only the prefix is kept as it is.
 */
export function titleWithoutPrefix(title: string, cfg: VaultConfig): string {
  for (const rule of cfg.meetings.area_rules) {
    if (rule.title_prefix === undefined || !hasTitlePrefix(title, rule.title_prefix)) continue;
    const rest = title
      .normalize("NFC")
      .trimStart()
      .slice(rule.title_prefix.normalize("NFC").length)
      .trim();
    return rest === "" ? title : rest;
  }
  return title;
}

/**
 * The area of the first `meetings.area_rules` entry that matches the event's calendar id, the
 * start of the event title, or the exact email domain of the input organizer, the event organizer
 * or any participant. Without a match: `default_area`, or the first configured area when that is
 * null.
 */
export function routeArea(
  event: CalendarEvent | undefined,
  input: MeetingInput,
  cfg: VaultConfig,
): string {
  const domains = new Set<string>();
  const emails = [
    input.organizerEmail,
    event?.organizer?.email,
    ...input.people.map((p) => p.email),
  ];
  for (const email of emails) {
    const domain = domainOf(email);
    if (domain !== undefined) domains.add(domain);
  }
  for (const rule of cfg.meetings.area_rules) {
    if (rule.calendar !== undefined && event?.calendar_id === rule.calendar) return rule.area;
    if (rule.title_prefix !== undefined && hasTitlePrefix(event?.title, rule.title_prefix)) {
      return rule.area;
    }
    if (rule.domain !== undefined && domains.has(rule.domain.trim().toLowerCase())) {
      return rule.area;
    }
  }
  return cfg.meetings.default_area ?? cfg.areas[0] ?? "";
}
