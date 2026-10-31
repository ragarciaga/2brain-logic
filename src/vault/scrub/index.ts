import { isPlaceholder, LABEL_KEY, REDACTED_PREFIX, SCRUB_RULES, type ScrubRule } from "./rules.js";

export {
  IBAN_LENGTHS,
  ibanValid,
  isPlaceholder,
  LABEL_KEY,
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

function startsRedacted(found: string): boolean {
  const offset =
    found.charAt(0) === '"' || found.charAt(0) === "'" || found.charAt(0) === "`" ? 1 : 0;
  return found.startsWith(REDACTED_PREFIX, offset);
}

/** Applies one rule with a single `replace` pass and returns the new text and the hit count. */
function applyRule(text: string, rule: ScrubRule): { text: string; count: number } {
  if (!RULE_ID.test(rule.id) || !rule.pattern.global) throw new ScrubError(rule.id);
  const mark = placeholder(rule.id);
  let count = 0;
  const out = text.replace(rule.pattern, (...args: unknown[]) => {
    const match = args[0] as string;
    const last = args[args.length - 1];
    const groups =
      typeof last === "object" && last !== null
        ? (last as { keep?: string; secret?: string })
        : undefined;
    const keep = groups?.keep;
    const hidden = groups?.secret;
    if ((keep === undefined) !== (hidden === undefined)) throw new ScrubError(rule.id);
    if (keep !== undefined && hidden !== undefined && keep + hidden !== match) {
      throw new ScrubError(rule.id);
    }
    const found = hidden ?? match;
    if (startsRedacted(found)) return match;
    if (!rule.select) {
      count++;
      return (keep ?? "") + mark;
    }
    let result = keep ?? "";
    let position = 0;
    let spans = 0;
    for (let from = 0; ; ) {
      const span = rule.select(found, from);
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
    if (spans === 0) return match;
    count += spans;
    return result + found.slice(position);
  });
  return { text: out, count };
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

function addHits(into: Map<string, number>, from: Map<string, number>): void {
  for (const [id, count] of from) into.set(id, (into.get(id) ?? 0) + count);
}

/** Scrubs one string; under a label key an unrecognized value is redacted as a whole. */
function scrubString(
  value: string,
  labeled: boolean,
  rules: readonly ScrubRule[],
  hits: Map<string, number>,
): string {
  const result = scrub(value, rules);
  if (labeled && !isPlaceholder(value) && hasLongRun(result.text)) {
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
        scrubValue(item, LABEL_KEY.test(key), rules, hits),
      ]),
    );
  }
  return value;
}

/**
 * Scrubs every string in a nested object. A key that names a secret (see `LABEL_KEY`) makes its
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
