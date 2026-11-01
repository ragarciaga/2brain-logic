import type { ScrubFrontmatterResult, ScrubResult } from "./scrub/index.js";

// A leaf module (no import of write-note.ts or write-meeting.ts): both use it, and a test can
// observe the calls of `scrubNote` through a module mock.

/** How many times one scrub rule redacted something in a note. Rule id and count only. */
export interface Redaction {
  rule: string;
  count: number;
}

export interface Scrubber {
  scrub(text: string): ScrubResult;
  scrubFrontmatter(data: Record<string, unknown>): ScrubFrontmatterResult;
}

/**
 * The secret scrub could not finish (a rule failed, or the data was too deep or cyclic). The
 * message is fixed and the error carries no `cause`: nothing from the scrubber or the note reaches
 * a response or a log through it.
 */
export class ScrubFailedError extends Error {
  constructor() {
    super("Secret scrub failed");
    this.name = "ScrubFailedError";
  }
}

/** Combine redaction counts of several scrub results, sorted by rule id. */
export function toRedactions(...maps: ReadonlyMap<string, number>[]): Redaction[] {
  const counts = new Map<string, number>();
  for (const hits of maps) {
    for (const [rule, count] of hits) counts.set(rule, (counts.get(rule) ?? 0) + count);
  }
  return [...counts]
    .map(([rule, count]) => ({ rule, count }))
    .sort((a, b) => (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0));
}

/**
 * Scrub every string of the frontmatter (nested values included) and the body. Any exception from
 * the scrubber becomes `ScrubFailedError` without a cause. Redaction counts of both parts are
 * combined and sorted by rule id.
 */
export function scrubNote(
  scrubber: Scrubber,
  frontmatter: Record<string, unknown>,
  body: string,
): { frontmatter: Record<string, unknown>; body: string; redactions: Redaction[] } {
  let scrubbedFrontmatter: ScrubFrontmatterResult;
  let scrubbedBody: ScrubResult;
  let redactions: Redaction[];
  try {
    scrubbedFrontmatter = scrubber.scrubFrontmatter(frontmatter);
    scrubbedBody = scrubber.scrub(body);
    redactions = toRedactions(scrubbedFrontmatter.hits, scrubbedBody.hits);
  } catch {
    throw new ScrubFailedError();
  }
  return { frontmatter: scrubbedFrontmatter.data, body: scrubbedBody.text, redactions };
}
