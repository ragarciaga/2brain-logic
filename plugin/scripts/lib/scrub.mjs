const MARK = "[redacted]";
const LEFT = "(?<![A-Za-z0-9_-])";
const ESCAPED_VALUE = String.raw`\\"(?:[^\\\r\n]|\\(?!"))*(?:\\")?`;
const NAME = "[A-Za-z_][A-Za-z0-9_.-]{0,63}";

/**
 * @typedef {object} Rule
 * @property {string} id
 * @property {RegExp} pattern global regex
 * @property {(...args: any[]) => string} replace replacer; returns the match unchanged to skip it
 * @property {(text: string) => string} [run] custom pass used instead of pattern and replace
 */

/** Counts replacements made by the rule currently running. */
let hits = 0;

/** @param {string} _ @returns {string} */
const whole = (_) => {
  hits++;
  return MARK;
};

/** Name words that mark an assignment as secret-bearing (substring, any case). */
const SECRET_WORDS = ["KEY", "TOKEN", "SECRET", "PASS", "PWD", "CREDENTIAL"];

/** A last word that turns the name into something else ("token_count", "keyFile"). */
const DENIED_LAST = new Set([
  "count",
  "id",
  "ids",
  "type",
  "types",
  "length",
  "len",
  "limit",
  "max",
  "min",
  "size",
  "url",
  "uri",
  "name",
  "names",
  "path",
  "file",
  "ttl",
  "expiry",
  "expires",
  "header",
  "endpoint",
  "policy",
  "hint",
  "prompt",
  "index",
  "keys",
  "tokens",
]);

/** Keys that are not credentials ("primary_key", "sortKey", "hotkey"). */
const DENIED_KEY = /(?:primary|foreign|sort|hot|partition|cache|public|shard|order|group)key$/;

/**
 * True when an assignment name holds a secret word and does not end in a denied word.
 * @param {string} name
 * @returns {boolean}
 */
function secretName(name) {
  const up = name.toUpperCase();
  if (up === "PWD" || up === "OLDPWD") return false;
  if (!SECRET_WORDS.some((w) => up.includes(w))) return false;
  const words = name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z]+/)
    .filter((w) => w !== "")
    .map((w) => w.toLowerCase());
  const last = words[words.length - 1];
  if (last === undefined || DENIED_LAST.has(last)) return false;
  return !DENIED_KEY.test(words.join(""));
}

/**
 * @param {string} value
 * @returns {string | null} the replacement value, or null to leave it alone
 */
function redactValue(value) {
  const open = value.startsWith('\\"') ? '\\"' : value[0];
  if (open === '\\"' || open === '"' || open === "'") {
    const closed = value.length > open.length && value.endsWith(open);
    const inner = value.slice(open.length, closed ? -open.length : undefined);
    if (inner === MARK) return null;
    return open + MARK + (closed ? open : "");
  }
  return value === MARK ? null : MARK;
}

/**
 * Replacer that keeps capture group 1 and redacts the last capture group.
 * @param {string} match
 * @param {...any} args
 * @returns {string}
 */
function keepAndRedact(match, ...args) {
  const groups = args.slice(
    0,
    args.findIndex((a) => typeof a === "number"),
  );
  const secret = /** @type {string} */ (groups[groups.length - 1]);
  if (secret === MARK || secret.trim() === MARK) return match;
  hits++;
  return match.slice(0, match.length - secret.length) + MARK;
}

/**
 * The part of an assignment before its value: `--name `, `--name=` or `name"?: `. Scanning only
 * the head keeps the scan linear and lets a non-secret label ("USER:", "Note:") be skipped without
 * hiding an assignment that follows it.
 */
const ASSIGNMENT_HEAD = new RegExp(
  `${LEFT}(?:--(?<n1>${NAME})(?:[ \\t]{1,20}|[ \\t]{0,20}[:=](?!=)[ \\t]{0,20})|(?<n2>${NAME})(?:\\\\?["'])?[ \\t]{0,20}[:=](?!=)[ \\t]{0,20})`,
  "g",
);
const ASSIGNMENT_VALUE = new RegExp(
  `(?:${ESCAPED_VALUE}|"[^"\\r\\n]*"?|'[^'\\r\\n]*'?|[^\\s"']+)`,
  "y",
);

/**
 * Redacts the value of every secret-named assignment. A non-secret name is skipped past its head
 * only, so `USER: API_KEY=v` and `a: b: TOKEN=v` still reach the inner assignment.
 * @param {string} text
 * @returns {string}
 */
function redactAssignments(text) {
  const head = new RegExp(ASSIGNMENT_HEAD.source, "g");
  const valueRe = new RegExp(ASSIGNMENT_VALUE.source, "y");
  let out = "";
  let last = 0;
  head.lastIndex = 0;
  for (let m = head.exec(text); m !== null; m = head.exec(text)) {
    const start = m.index + m[0].length;
    if (!secretName(m.groups?.n1 ?? m.groups?.n2 ?? "")) continue;
    valueRe.lastIndex = start;
    const v = valueRe.exec(text);
    if (v === null) continue;
    head.lastIndex = start + v[0].length;
    const next = redactValue(v[0]);
    if (next === null) continue;
    hits++;
    out += text.slice(last, start) + next;
    last = start + v[0].length;
  }
  return out + text.slice(last);
}

/**
 * Fixed, ordered list. Every quantifier before a required token is bounded, or runs over a class
 * that excludes what follows it. Most rules start with a one-character left lookbehind;
 * private_key and url_userinfo have none (their fixed opening text is the boundary). A hostile
 * input therefore stays linear.
 * @type {readonly Readonly<Rule>[]}
 */
export const RULES = Object.freeze([
  Object.freeze({
    id: "private_key",
    pattern:
      /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----|$)/g,
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
    id: "url_userinfo",
    pattern: /([A-Za-z][A-Za-z0-9+.-]{0,30}:\/\/[^\s/:@"'<>]{0,100}:)([^\s/@"'<>]{1,200})(?=@)/g,
    replace: keepAndRedact,
  }),
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
    id: "basic",
    pattern: new RegExp(
      `${LEFT}([Bb][Aa][Ss][Ii][Cc][ \\t]{1,20})(?=[a-z]{0,200}[A-Z0-9+/=])([A-Za-z0-9+/]{12,}=*)`,
      "g",
    ),
    replace: keepAndRedact,
  }),
  Object.freeze({
    id: "curl_user",
    pattern: new RegExp(
      `${LEFT}((?:-u|--user)[ \\t=]{1,20}["']?[^\\s:"']{1,100}:)([^\\s"']{1,200})`,
      "g",
    ),
    /** @param {string} match @param {string} keep @param {string} secret */
    replace: (match, keep, secret) =>
      // A numeric uid:gid pair (chown, docker -u) is not a credential.
      /[ \t="']\d+:$/.test(keep) && /^\d+$/.test(secret)
        ? match
        : keepAndRedact(match, keep, secret, 0),
  }),
  Object.freeze({
    id: "cookie",
    pattern: new RegExp(
      `${LEFT}((?:set-)?cookie(?:\\\\?["'])?[ \\t]{0,20}:[ \\t]{0,20}(?:\\\\?["'])?)([^\\r\\n"'\\\\]+)`,
      "gi",
    ),
    replace: keepAndRedact,
  }),
  Object.freeze({
    id: "assignment",
    pattern: ASSIGNMENT_HEAD,
    /** @param {string} match */
    replace: (match) => match,
    run: redactAssignments,
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
    out = rule.run ? rule.run(out) : out.replace(rule.pattern, rule.replace);
    count += hits;
  }
  return { text: out, count };
}
