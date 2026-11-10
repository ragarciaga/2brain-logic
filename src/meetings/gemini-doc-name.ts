// Parses the name Google gives a "Notes by Gemini" doc. Pure: no I/O, no config.
//
//   <title> - YYYY/MM/DD HH:MM <zone> - Notes by Gemini
//   <title> - YYYY/MM/DD HH:MM <zone> - Notes by Gemini (<language>)
//
// The zone is the organizer's: `GMT`, `UTC`, `GMT+01:00`, `GMT-5` or an abbreviation from the
// table below. Anything else is refused, so a meeting is never stored at a guessed time.

/** Offsets in minutes east of UTC. CST is US and Mexico Central time. */
export const ZONE_OFFSETS: Readonly<Record<string, number>> = Object.freeze({
  UTC: 0,
  GMT: 0,
  WET: 0,
  WEST: 60,
  BST: 60,
  CET: 60,
  CEST: 120,
  EET: 120,
  EEST: 180,
  WAT: 60,
  CAT: 120,
  EAT: 180,
  IST: 330,
  NPT: 345,
  COT: -300,
  PET: -300,
  ART: -180,
  BRT: -180,
  CLT: -240,
  CLST: -180,
  VET: -240,
  BOT: -240,
  AST: -240,
  ADT: -180,
  EST: -300,
  EDT: -240,
  CST: -360,
  CDT: -300,
  MST: -420,
  MDT: -360,
  PST: -480,
  PDT: -420,
});

const NAME =
  /^(.+?) - (\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}) ([A-Za-z]{2,5}|(?:GMT|UTC)[+-]\d{1,2}(?::\d{2})?) - Notes by Gemini(?: \(([^()]{1,40})\))?$/;

const NUMERIC_ZONE = /^(?:GMT|UTC)([+-])(\d{1,2})(?::(\d{2}))?$/;

function zoneOffset(zone: string): number | undefined {
  const numeric = NUMERIC_ZONE.exec(zone);
  if (numeric !== null) {
    const hours = Number(numeric[2]);
    const minutes = Number(numeric[3] ?? "0");
    if (hours > 14 || minutes > 59) return undefined;
    return (numeric[1] === "-" ? -1 : 1) * (hours * 60 + minutes);
  }
  return ZONE_OFFSETS[zone.toUpperCase()];
}

export interface GeminiDocName {
  title: string;
  start: Date;
  language?: string;
}

/** The title, start and language of a Gemini notes doc name, or undefined for any other name. */
export function parseGeminiDocName(name: string): GeminiDocName | undefined {
  const match = NAME.exec(name.normalize("NFC").trim());
  if (match === null) return undefined;
  const [, rawTitle, y, mo, d, h, mi, zone, language] = match;
  const title = (rawTitle ?? "").trim();
  const offset = zoneOffset(zone ?? "");
  if (title === "" || offset === undefined) return undefined;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return undefined;
  const utc = Date.UTC(year, month - 1, day, hour, minute) - offset * 60_000;
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCMonth() !== month - 1) return undefined;
  const parsed: GeminiDocName = { title, start: new Date(utc) };
  if (language !== undefined) parsed.language = language.trim();
  return parsed;
}
