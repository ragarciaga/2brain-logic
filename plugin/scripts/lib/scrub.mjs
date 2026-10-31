const MARK = "[redacted]";
const LEFT = "(?<![A-Za-z0-9_-])";
const NAME = "[A-Za-z_][A-Za-z0-9_.-]{0,63}";

/**
 * @typedef {object} Rule
 * @property {string} id
 * @property {RegExp} pattern global regex
 * @property {(...args: any[]) => string} replace replacer; returns the match unchanged to skip it
 */

/** Counts replacements made by the rule currently running. */
let hits = 0;

/** @param {string} _ @returns {string} */
const whole = (_) => {
  hits++;
  return MARK;
};

/**
 * Names that mark an assignment as secret-bearing.
 * @param {string} name
 * @returns {boolean}
 */
function secretName(name) {
  const up = name.toUpperCase();
  return (
    up.includes("KEY") || up.includes("TOKEN") || up.includes("SECRET") || up.includes("PASSWORD")
  );
}

/**
 * @param {string} value
 * @returns {string | null} the replacement value, or null to leave it alone
 */
function redactValue(value) {
  const q = value[0];
  if (q === '"' || q === "'") {
    const closed = value.length > 1 && value.endsWith(q);
    const inner = value.slice(1, closed ? -1 : undefined);
    if (inner === MARK) return null;
    return `${q}${MARK}${closed ? q : ""}`;
  }
  return value === MARK ? null : MARK;
}

/**
 * Fixed, ordered list. Every left boundary is a one-character lookbehind and every quantifier
 * before a required token is bounded, so a hostile input stays linear.
 * @type {readonly Readonly<Rule>[]}
 */
export const RULES = Object.freeze([
  Object.freeze({
    id: "private_key",
    pattern: new RegExp(
      `${LEFT}-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----[\\s\\S]*?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----|$)`,
      "g",
    ),
    replace: whole,
  }),
  ...[
    ["anthropic_key", "sk-ant-[A-Za-z0-9_-]{20,}"],
    ["github_token", "gh[pousr]_[A-Za-z0-9]{36,}"],
    ["github_pat", "github_pat_[A-Za-z0-9_]{22,}"],
    ["slack_token", "xox[abeoprs]-[A-Za-z0-9-]{10,}"],
    ["aws_access_key_id", "(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])"],
  ].map(([id, body]) =>
    Object.freeze({ id, pattern: new RegExp(LEFT + body, "g"), replace: whole }),
  ),
  Object.freeze({
    id: "bearer",
    pattern: new RegExp(`${LEFT}(bearer[ \\t]{1,20})[A-Za-z0-9._~+/-]{16,}=*`, "gi"),
    /** @param {string} _ @param {string} keep */
    replace: (_, keep) => {
      hits++;
      return keep + MARK;
    },
  }),
  Object.freeze({
    id: "assignment",
    pattern: new RegExp(
      `${LEFT}(?:--(?<n1>${NAME})(?:[ \\t]{1,20}|[ \\t]{0,20}[:=][ \\t]{0,20})|(?<n2>${NAME})["']?[ \\t]{0,20}[:=][ \\t]{0,20})(?<v>"[^"\\r\\n]*"?|'[^'\\r\\n]*'?|[^\\s"']+)`,
      "g",
    ),
    /** @param {...any} args */
    replace: (...args) => {
      const match = /** @type {string} */ (args[0]);
      const groups = /** @type {Record<string, string | undefined>} */ (args[args.length - 1]);
      const name = groups.n1 ?? groups.n2 ?? "";
      const value = groups.v ?? "";
      if (!secretName(name)) return match;
      const next = redactValue(value);
      if (next === null) return match;
      hits++;
      return match.slice(0, match.length - value.length) + next;
    },
  }),
]);

/**
 * Replaces secret-shaped strings with `[redacted]`. Pure; applies RULES in order.
 * @param {string} text
 * @returns {{ text: string, count: number }}
 */
export function preScrub(text) {
  let out = typeof text === "string" ? text : "";
  let count = 0;
  for (const rule of RULES) {
    hits = 0;
    out = out.replace(rule.pattern, rule.replace);
    count += hits;
  }
  return { text: out, count };
}
