import type { VaultConfig } from "../config/vault-config.js";

export interface FrontmatterValid {
  ok: true;
  /** The key in `config.types` whose `value` the note carries. */
  typeKey: string;
  area: string;
}

export interface FrontmatterInvalid {
  ok: false;
  error: "invalid_frontmatter";
  /** Owner property names that are absent (or null), in the order type, area, date, source. */
  missing: string[];
  /** Owner property names that are present with a rejected value, in the same order. */
  invalid: string[];
}

export interface WrongFolder {
  ok: false;
  error: "wrong_folder";
  /** The folder the note must be inside, with `{area}` expanded. */
  expected: string;
}

export type FrontmatterVerdict = FrontmatterValid | FrontmatterInvalid | WrongFolder;

/** An own property of `obj`, or undefined. Owner names such as `constructor` must not hit the prototype. */
function readOwn(obj: Record<string, unknown>, name: string): unknown {
  return Object.hasOwn(obj, name) ? obj[name] : undefined;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** A strict `YYYY-MM-DD` string naming a real Gregorian calendar date. */
function isCalendarDate(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= (daysInMonth[month - 1] as number);
}

/**
 * Check a note's frontmatter and path against the vault config. The path is assumed to be
 * `NoteInput`-validated already (T4 owns path safety). Property names come from
 * `config.properties`; only own properties of `frontmatter` are read. Error results carry owner
 * property names and the expected folder only, never a value from the note. The folder check runs
 * only when every property is valid, so a frontmatter problem is always `invalid_frontmatter`.
 * `source_id` is not checked here.
 */
export function validateFrontmatter(
  frontmatter: Record<string, unknown>,
  path: string,
  config: VaultConfig,
): FrontmatterVerdict {
  const missing: string[] = [];
  const invalid: string[] = [];

  const fail = (name: string, value: unknown): void => {
    (value === undefined || value === null ? missing : invalid).push(name);
  };

  const names = config.properties;

  const typeValue = readOwn(frontmatter, names.type);
  let typeKey: string | undefined;
  if (typeof typeValue === "string") {
    typeKey = Object.entries(config.types).find(([, entry]) => entry.value === typeValue)?.[0];
  }
  if (typeKey === undefined) fail(names.type, typeValue);

  const areaValue = readOwn(frontmatter, names.area);
  const area =
    typeof areaValue === "string" && config.areas.includes(areaValue) ? areaValue : undefined;
  if (area === undefined) fail(names.area, areaValue);

  const dateValue = readOwn(frontmatter, names.date);
  if (!isCalendarDate(dateValue)) fail(names.date, dateValue);

  const sourceValue = readOwn(frontmatter, names.source);
  const sourceOk =
    typeof sourceValue === "string" &&
    sourceValue !== "" &&
    (config.sources.length === 0 || config.sources.includes(sourceValue));
  if (!sourceOk) fail(names.source, sourceValue);

  if (missing.length > 0 || invalid.length > 0 || typeKey === undefined || area === undefined) {
    return { ok: false, error: "invalid_frontmatter", missing, invalid };
  }

  const folder = (config.types[typeKey] as { folder?: string | undefined }).folder;
  if (folder !== undefined) {
    const expected = folder.replaceAll("{area}", area);
    if (!path.startsWith(`${expected}/`)) {
      return { ok: false, error: "wrong_folder", expected };
    }
  }
  return { ok: true, typeKey, area };
}
