import {
  isLabelKey,
  isPlaceholder,
  REDACTED_PREFIX,
  SCRUB_RULES,
  type ScrubRule,
  startsRedacted,
} from "./rules.js";

export {
  IBAN_LENGTHS,
  ibanValid,
  isLabelKey,
  isPlaceholder,
  luhnValid,
  SCRUB_RULES,
  type ScrubRule,
  type ScrubSpan,
} from "./rules.js";

const RULE_ID = /^[a-z][a-z0-9_]*$/;
const LABELED_ID = "labeled_secret";

/** A rule failed. The message names the rule id and nothing else: never the text or the match. */
export class ScrubError extends Error {
  readonly rule: string;

  constructor(rule: string) {
    const safe = RULE_ID.test(rule) ? rule : "unknown";
    super(`Scrub rule ${safe} failed`);
    this.name = "ScrubError";
    this.rule = safe;
  }
}

export interface ScrubResult {
  text: string;
  /** Redactions per rule id; only rules with at least one hit appear. */
  hits: Map<string, number>;
}

export interface ScrubFrontmatterResult {
  data: Record<string, unknown>;
  hits: Map<string, number>;
}

function placeholder(id: string): string {
  return `${REDACTED_PREFIX}${id}]`;
}

/**
 * Applies one rule in a single forward pass over a private copy of its pattern and returns the new
 * text and the hit count. A rule with a `tail` is read head first: a head `admit` rejects is
 * skipped and the scan resumes right after it, a head without a tail match likewise, and a head
 * with one continues as a `keep` and `secret` match whose scan resumes after the tail.
 */
function applyRule(text: string, rule: ScrubRule): { text: string; count: number } {
  if (!RULE_ID.test(rule.id) || !rule.pattern.global) throw new ScrubError(rule.id);
  if (rule.tail !== undefined && !rule.tail.sticky) throw new ScrubError(rule.id);
  const mark = placeholder(rule.id);
  const scan = new RegExp(rule.pattern.source, rule.pattern.flags);
  const tail = rule.tail ? new RegExp(rule.tail.source, rule.tail.flags) : undefined;
  let count = 0;
  let out = "";
  let copied = 0; // text before this offset is already in `out`
  for (let m = scan.exec(text); m !== null; m = scan.exec(text)) {
    const match = m[0];
    const groups = m.groups as Record<string, string | undefined> | undefined;
    const keep = groups?.keep;
    let hidden = groups?.secret;
    let end = m.index + match.length;
    if (tail !== undefined) {
      if (keep !== match || hidden !== undefined) throw new ScrubError(rule.id);
      if (rule.admit !== undefined && !rule.admit(groups ?? {})) {
        scan.lastIndex = Math.max(end, m.index + 1);
        continue;
      }
      tail.lastIndex = end;
      const value = tail.exec(text);
      if (value === null || value[0] === "") {
        scan.lastIndex = Math.max(end, m.index + 1);
        continue;
      }
      hidden = value[0];
      end += hidden.length;
    } else if ((keep === undefined) !== (hidden === undefined)) {
      throw new ScrubError(rule.id);
    } else if (keep !== undefined && hidden !== undefined && keep + hidden !== match) {
      throw new ScrubError(rule.id);
    }
    scan.lastIndex = Math.max(end, m.index + 1);
    const found = hidden ?? match;
    if (startsRedacted(found)) continue;
    let result = keep ?? "";
    if (!rule.select) {
      count++;
      result += mark;
    } else {
      const named = tail !== undefined ? { ...groups, secret: found } : (groups ?? {});
      let position = 0;
      let spans = 0;
      for (let from = 0; ; ) {
        const span = rule.select(found, from, named);
        if (span === null) break;
        if (
          !Number.isInteger(span.start) ||
          !Number.isInteger(span.end) ||
          span.start < from ||
          span.end <= span.start ||
          span.end > found.length
        ) {
          throw new ScrubError(rule.id);
        }
        result += found.slice(position, span.start) + mark;
        position = span.end;
        from = span.end;
        spans++;
      }
      if (spans === 0) continue;
      count += spans;
      result += found.slice(position);
    }
    out += text.slice(copied, m.index) + result;
    copied = end;
  }
  return { text: out + text.slice(copied), count };
}

/**
 * Replaces every match of every rule, in order, with `[REDACTED:<rule>]`. Idempotent on its own
 * output. Any failure inside a rule surfaces as `ScrubError` carrying only the rule id.
 */
export function scrub(text: string, rules: readonly ScrubRule[] = SCRUB_RULES): ScrubResult {
  const hits = new Map<string, number>();
  let current = text;
  for (const rule of rules) {
    let applied: { text: string; count: number };
    try {
      applied = applyRule(current, rule);
    } catch {
      throw new ScrubError(rule.id);
    }
    current = applied.text;
    if (applied.count > 0) hits.set(rule.id, (hits.get(rule.id) ?? 0) + applied.count);
  }
  return { text: current, hits };
}

const PLACEHOLDER_ANYWHERE = /\[REDACTED:[a-z][a-z0-9_]*\]/g;

/** True when, outside placeholders, a run of 6 or more non-space characters remains. */
function hasLongRun(text: string): boolean {
  return /\S{6}/.test(text.replace(PLACEHOLDER_ANYWHERE, " "));
}

/** True when the text already carries a placeholder (a result of an earlier scrub). */
function hasPlaceholder(text: string): boolean {
  return new RegExp(PLACEHOLDER_ANYWHERE.source).test(text);
}

function addHits(into: Map<string, number>, from: Map<string, number>): void {
  for (const [id, count] of from) into.set(id, (into.get(id) ?? 0) + count);
}

/**
 * Scrubs one string. Under a label key an unrecognized value is redacted as a whole: when no rule
 * hit and the value has 6 or more characters after trimming (a passphrase with spaces counts), or
 * when a rule hit and a run of 6 or more non-space characters is left. A value that already holds
 * a placeholder only gets the run test, so scrubbing the output again changes nothing.
 */
function scrubString(
  value: string,
  labeled: boolean,
  rules: readonly ScrubRule[],
  hits: Map<string, number>,
): string {
  const result = scrub(value, rules);
  const whole = result.hits.size === 0 && !hasPlaceholder(value);
  if (
    labeled &&
    !isPlaceholder(value) &&
    (whole ? value.trim().length >= 6 : hasLongRun(result.text))
  ) {
    hits.set(LABELED_ID, (hits.get(LABELED_ID) ?? 0) + 1);
    return placeholder(LABELED_ID);
  }
  addHits(hits, result.hits);
  return result.text;
}

function scrubValue(
  value: unknown,
  labeled: boolean,
  rules: readonly ScrubRule[],
  hits: Map<string, number>,
): unknown {
  if (typeof value === "string") return scrubString(value, labeled, rules, hits);
  if ((typeof value === "number" && Number.isFinite(value)) || typeof value === "bigint") {
    const asText = String(value);
    const replaced = scrubString(asText, labeled, rules, hits);
    return replaced === asText ? value : replaced;
  }
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, labeled, rules, hits));
  if (typeof value === "object" && value !== null) {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        scrubValue(item, isLabelKey(key), rules, hits),
      ]),
    );
  }
  return value;
}

/**
 * Scrubs every string in a nested object. A key that names a secret (see `isLabelKey`) makes its
 * value, and the elements of an array under it, count as labeled. Numbers and bigints are checked
 * as text and become the placeholder string on a hit. The input is never mutated; keys, booleans,
 * null, Dates and other objects pass through unchanged.
 */
export function scrubFrontmatter(
  data: Record<string, unknown>,
  rules: readonly ScrubRule[] = SCRUB_RULES,
): ScrubFrontmatterResult {
  const hits = new Map<string, number>();
  const out = scrubValue(data, false, rules, hits) as Record<string, unknown>;
  return { data: out, hits };
}
