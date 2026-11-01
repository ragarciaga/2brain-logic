/**
 * Secret scrub rules (R4.2). Pure data and validators: nothing here touches a vault, a file or the
 * network. `index.ts` applies the rules in order; the first rule to redact a span wins, so the
 * list runs from the most specific format to the loosest one.
 *
 * Design limits that keep a hostile 1 MiB note from stalling a write:
 * - every left boundary is a one-character lookbehind, every quantifier before a required token is
 *   bounded, and an unbounded one either ends the pattern, runs over a class that excludes the
 *   token that follows it (the quoted-value body excludes its quote, see `quotedValue`), or is a
 *   lazy body that stops at the first closing marker or at the end of the text (`private_key`; the
 *   lazy lookaheads of `escapedValue` stop at their line);
 * - the label candidate of `labeled_secret` has no left boundary, but its length is capped (64
 *   characters for an identifier, 4 words for a spaced label, each word but the last under 16
 *   characters); the words are judged by `isLabelKey` on that candidate only, never on the text;
 * - a rule that validates a candidate (IBAN, card) does it in `select`, which resumes by offset;
 *   the label rule finds only the head of an assignment (label and separator) and judges the
 *   label with `admit` before its value is read at all (`tail`), and a rejected head resumes the
 *   scan right after itself. Either way the total work stays linear in the input.
 */

/** A half-open range `[start, end)` inside the text a rule is asked to redact. */
export interface ScrubSpan {
  start: number;
  end: number;
}

export interface ScrubRule {
  /** Matches `^[a-z][a-z0-9_]*$`; it becomes the name in `[REDACTED:<id>]` and in the hit counts. */
  id: string;
  /**
   * Global regex. With named groups `keep` and `secret`, `keep + secret` must equal the whole
   * match: `keep` stays and `secret` is what gets examined. Without them the whole match is.
   * The scanner runs a private copy, so the shared `lastIndex` never leaks.
   */
  pattern: RegExp;
  /**
   * Makes `pattern` only the head of the match. A sticky regex. The pattern then has a `keep`
   * group equal to the whole match and no `secret` group. For each head, `admit` (default:
   * always) is asked first; a head it rejects is skipped and the scan resumes right after the
   * head, so a rejected head costs only the head pattern and the text after it is examined
   * normally. For an admitted head, `tail` is matched at the end of the head: no match resumes
   * after the head; a match is the `secret`, handled as with a `keep` and `secret` pattern, and
   * the scan resumes after it.
   */
  tail?: RegExp;
  /** Judges a head of a rule with a `tail` by its named groups. Never called without `tail`. */
  admit?: (groups: Readonly<Record<string, string | undefined>>) => boolean;
  /**
   * Narrows or validates what was found. Returns the earliest span at or after `from`, or null.
   * The caller asks again from the end of each span, so a found value holding several secrets
   * yields several spans. Read by offset; never slice inside a loop (that would be quadratic).
   * `groups` holds the named groups of the match (`keep`, `secret` and any others).
   */
  select?: (
    found: string,
    from: number,
    groups: Readonly<Record<string, string | undefined>>,
  ) => ScrubSpan | null;
}

export const REDACTED_PREFIX = "[REDACTED:";

/** True when a matched value, past an opening quote (escaped or not), already is a placeholder. */
export function startsRedacted(found: string): boolean {
  let offset = found.charAt(0) === "\\" ? 1 : 0;
  const quote = found.charAt(offset);
  if (quote === '"' || quote === "'" || quote === "`") offset++;
  else offset = 0;
  return found.startsWith(REDACTED_PREFIX, offset);
}

// ---------------------------------------------------------------------------------------------
// Helpers

const PLACEHOLDER_SHAPES: readonly RegExp[] = [
  /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/, // ${NAME}
  /^\$\{\{[^{}\r\n]{1,200}\}\}$/, // ${{ expression }}
  /^\$[A-Z_][A-Z0-9_]*$/, // $UPPER_NAME
  /^<[^<>\r\n]{1,200}>$/, // <your-value>
  /^\{\{[^{}\r\n]{1,200}\}\}$/, // {{ template }}
  /^%[sd]$/, // printf style
];

/** True for a value that only points at a secret held elsewhere. Exact shapes, never a prefix. */
export function isPlaceholder(value: string): boolean {
  return value.length <= 210 && PLACEHOLDER_SHAPES.some((shape) => shape.test(value));
}

const DOUBLED = [0, 2, 4, 6, 8, 1, 3, 5, 7, 9] as const;

/** Luhn check over 13 to 19 digits; spaces and hyphens between digits are ignored. */
export function luhnValid(value: string): boolean {
  const digits = value.replace(/[ -]/g, "");
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    const d = digits.charCodeAt(digits.length - 1 - i) - 48;
    sum += i % 2 === 1 ? (DOUBLED[d] ?? 0) : d;
  }
  return sum % 10 === 0;
}

/**
 * IBAN length per country. A hand transcription of the SWIFT IBAN Registry (ISO 13616), not yet
 * checked against a named registry release: the check is tracked in
 * https://github.com/ragarciaga/2brain-logic/issues/41. The test pins the table's own count (89
 * countries). A country missing here is a miss, never a crash; add it with its registry example
 * in tests/fixtures/scrub/iban-examples.json.
 */
export const IBAN_LENGTHS: Readonly<Record<string, number>> = Object.freeze({
  AD: 24,
  AE: 23,
  AL: 28,
  AT: 20,
  AZ: 28,
  BA: 20,
  BE: 16,
  BG: 22,
  BH: 22,
  BI: 27,
  BR: 29,
  BY: 28,
  CH: 21,
  CR: 22,
  CY: 28,
  CZ: 24,
  DE: 22,
  DJ: 27,
  DK: 18,
  DO: 28,
  EE: 20,
  EG: 29,
  ES: 24,
  FI: 18,
  FK: 18,
  FO: 18,
  FR: 27,
  GB: 22,
  GE: 22,
  GI: 23,
  GL: 18,
  GR: 27,
  GT: 28,
  HN: 28,
  HR: 21,
  HU: 28,
  IE: 22,
  IL: 23,
  IQ: 23,
  IS: 26,
  IT: 27,
  JO: 30,
  KW: 30,
  KZ: 20,
  LB: 28,
  LC: 32,
  LI: 21,
  LT: 20,
  LU: 20,
  LV: 21,
  LY: 25,
  MC: 27,
  MD: 24,
  ME: 22,
  MK: 19,
  MN: 20,
  MR: 27,
  MT: 31,
  MU: 30,
  NI: 28,
  NL: 18,
  NO: 15,
  OM: 23,
  PK: 24,
  PL: 28,
  PS: 29,
  PT: 25,
  QA: 29,
  RO: 24,
  RS: 22,
  RU: 33,
  SA: 24,
  SC: 31,
  SD: 18,
  SE: 24,
  SI: 19,
  SK: 24,
  SM: 27,
  SO: 23,
  ST: 25,
  SV: 28,
  TL: 23,
  TN: 24,
  TR: 26,
  UA: 29,
  VA: 22,
  VG: 24,
  XK: 20,
  YE: 30,
});

/** Country code, check digits and registry length plus mod-97 equal to 1. Spaces are ignored. */
export function ibanValid(value: string): boolean {
  const iban = value.replace(/ /g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(iban)) return false;
  const country = iban.slice(0, 2);
  if (!Object.hasOwn(IBAN_LENGTHS, country) || iban.length !== IBAN_LENGTHS[country]) return false;
  const check = Number(iban.slice(2, 4));
  if (check < 2 || check > 98) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (let i = 0; i < rearranged.length; i++) {
    const code = rearranged.charCodeAt(i);
    remainder = code <= 57 ? (remainder * 10 + code - 48) % 97 : (remainder * 100 + code - 55) % 97;
  }
  return remainder === 1;
}

// ---------------------------------------------------------------------------------------------
// Labeled assignments

// The pattern only finds a candidate label (an identifier of up to 64 characters, or up to 4 words
// joined by single spaces whose last word may run to 64 characters and whose others stay under 16)
// right before an assignment separator. `isLabelKey` judges the words, so a new spelling of a label
// needs no new regex branch.
const LABEL_WORD = "[A-Za-z][A-Za-z0-9_.-]";
const LABEL_CANDIDATE = `(?:${LABEL_WORD}{0,14}(?: ${LABEL_WORD}{0,14}){0,2} ${LABEL_WORD}{0,63}|${LABEL_WORD}{0,63})`;

// A word that names a secret on its own ("apikey" is the lowercase form of "APIKey"), and the
// words that name one when they follow "api", "access" or "private" ("API Key").
const LABEL_CORE_WORDS: ReadonlySet<string> = new Set([
  "password",
  "passwd",
  "pwd",
  "passphrase",
  "secret",
  "token",
  "credential",
  "credentials",
  "apikey",
  "secretkey",
  "accesskey",
  "privatekey",
]);
// A single word that ends with one of these names a secret too ("PGPASSWORD", "authtoken",
// "clientsecret", "mypwd"). "tokens", "tokenizer" and "passwordless" do not end with them.
const LABEL_COMPOUND_ENDINGS: readonly string[] = [
  "token",
  "password",
  "passwd",
  "pwd",
  "passphrase",
  "secret",
];
// A single word that names a key: a core word, "api", "access", "private" or "credential(s)", then
// "key" and at most one more "key" ("awssecretaccesskey", "GOOGLEAPIKEY", "sshprivatekey",
// "tokenkey", "apikeykey"); or one that ends with "credential" or "credentials" ("dbcredentials").
// "monkey", "keyboard" and "keykey" alone match neither: a core is required. A trailing digit run
// is already gone: `labelWords` splits at digits.
const LABEL_COMPOUND_KEY =
  /(?:password|passwd|pwd|passphrase|secret|token|api|access|private|credentials?)(?:access)?key(?:key)?$|credentials?$/;
// "key" (or "keykey") names a secret when the word before it ends with one of these ("API Key",
// "MYAPI_KEY", "API_KEYKEY").
const LABEL_KEY_PREFIXES: readonly string[] = ["api", "access", "private"];
// A last word that makes the name something else than a secret ("token_count", "api_key_name").
const LABEL_LAST_DENIED: ReadonlySet<string> = new Set([
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
]);

/**
 * Splits a label into lowercase words at non-letters (so digit runs too) and, when `camel` is set,
 * at camelCase edges. Without the camelCase split a core word written with a hump inside it
 * (`passWord`, `PassPhrase`, `PWd`) stays whole.
 */
function labelWords(label: string, camel: boolean): string[] {
  const spaced = camel
    ? label.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    : label;
  return spaced
    .split(/[^A-Za-z]+/)
    .filter((word) => word !== "")
    .map((word) => word.toLowerCase());
}

/** True when a list of lowercase words holds a core word, a compound or a key after a prefix. */
function namesSecret(words: readonly string[]): boolean {
  return words.some(
    (word, at) =>
      LABEL_CORE_WORDS.has(word) ||
      LABEL_COMPOUND_ENDINGS.some((ending) => word.endsWith(ending)) ||
      LABEL_COMPOUND_KEY.test(word) ||
      ((word === "key" || word === "keykey") &&
        at > 0 &&
        LABEL_KEY_PREFIXES.some((prefix) => (words[at - 1] as string).endsWith(prefix))),
  );
}

/**
 * True when a label (a text label before `=` or `:`, or a frontmatter key) names a secret: its
 * words hold a core word (`password`, `secret`, `token`, `api` + `key`, ...), a compound that
 * ends with one (`PGPASSWORD`, `authtoken`), a compound key (`AWSSECRETACCESSKEY`, `myapikey`,
 * `dbcredentials`), or `key` after a word that ends in `api`, `access` or `private` (`MYAPI_KEY`).
 * The words are read twice, split at camelCase edges and not split at them, and either list may
 * name the secret (`passWord`, `PassPhrase`, `sshPassPhrase`); the last camelCase word must not be
 * one that turns it into something else (`count`, `url`, `name`, ...). Only the last 4 spaced words
 * and the last 64 characters are read: a label is the end of the text before the separator.
 */
export function isLabelKey(label: string): boolean {
  const text = label.split(" ").slice(-4).join(" ").slice(-64);
  const words = labelWords(text, true);
  const last = words[words.length - 1];
  if (last === undefined || LABEL_LAST_DENIED.has(last)) return false;
  return namesSecret(words) || namesSecret(labelWords(text, false));
}

/**
 * A quoted value takes backslash escapes and has no upper length: the group has two alternatives
 * with different first characters, so every position has one way to match. An opening quote with
 * no closing one on the line (escapes honored) redacts to the end of the line.
 */
function quotedValue(quote: string): string {
  const body = String.raw`(?:[^${quote}\\\r\n]|\\.)`;
  return [`${quote}${body}{6,}${quote}`, `${quote}(?!${body}*${quote})[^\\r\\n]{6,}`].join("|");
}

/**
 * The same for a value that sits inside an already JSON-encoded string: it opens and closes with
 * an escaped quote (backslash, then the quote). The lookahead is lazy and stays on its line.
 */
function escapedValue(quote: string): string {
  const open = String.raw`\\${quote}`;
  const body = String.raw`(?:[^\\\r\n]|\\(?!${quote})[^\r\n]){6,}`;
  return [`${open}${body}${open}`, String.raw`${open}(?![^\r\n]*?${open})[^\r\n]{6,}`].join("|");
}

const LABELED_VALUE = [
  quotedValue('"'),
  quotedValue("'"),
  quotedValue(String.raw`\x60`),
  escapedValue('"'),
  escapedValue("'"),
  // A quote that closes again within 5 characters and is followed by 5 or more unspaced ones
  // ('it''s-...', "ab""...", 'O'Brien-...') takes the rest of its unspaced run, from after the
  // opening quote. A short value that is simply closed ("abcde") is not a secret and is kept.
  ...['"', "'", String.raw`\x60`].map(
    (quote) => String.raw`${quote}[^\s${quote}]{0,5}${quote}\S{5,}`,
  ),
  String.raw`[^\s"'\x60]{6,}`,
].join("|");

// The head is a label and its separator; the lookahead only checks that a value can start there
// (a quote, an escaped quote or 6 unspaced characters), so a separator that is followed by too
// little can still back off to a shorter one (":=" then ":"). The value is read by `LABELED_TAIL`
// and only for a head whose label `isLabelKey` admits, so a rejected head never scans its value.
const LABELED_PATTERN = new RegExp(
  `(?<keep>(?<label>${LABEL_CANDIDATE})(?:\\\\?["'\\x60])?[ \\t]{0,20}(?::=|=>|:|=)[ \\t]{0,20})(?=["'\\x60]|\\\\["']|[^\\s"'\\x60]{6})`,
  "gi",
);
const LABELED_TAIL = new RegExp(LABELED_VALUE, "y");

/** The part of a matched value to redact: quotes (escaped ones too) stay; a placeholder is kept. */
function valueSpan(found: string): ScrubSpan | null {
  let start = 0;
  let end = found.length;
  const first = found.charAt(0);
  const second = found.charAt(1);
  if (first === "\\" && (second === '"' || second === "'")) {
    start = 2;
    if (found.length >= 4 && found.endsWith(`\\${second}`)) end = found.length - 2;
  } else if (first === '"' || first === "'" || first === "`") {
    start = 1;
    if (found.length >= 2 && found.endsWith(first)) {
      // The last quote closes the value only when an even number of backslashes precedes it.
      let slashes = 0;
      while (found.charCodeAt(found.length - 2 - slashes) === 92) slashes++;
      if (slashes % 2 === 0) end = found.length - 1;
    }
  }
  if (isPlaceholder(found.slice(start, end))) return null;
  return { start, end };
}

/** The head was admitted by `isLabelKey`, so the value only needs its span (a placeholder is kept). */
function selectLabeled(found: string, from: number): ScrubSpan | null {
  return from === 0 ? valueSpan(found) : null;
}

// ---------------------------------------------------------------------------------------------
// IBAN

function isAsciiLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isAsciiDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

/**
 * Walks the word starts of a candidate run of letters, digits and single spaces and returns the
 * first IBAN: a known country, the registry length counted in alphanumerics, mod-97 equal to 1.
 */
function selectIban(found: string, from: number): ScrubSpan | null {
  const n = found.length;
  for (let i = from; i < n; i++) {
    if (i > 0 && found.charCodeAt(i - 1) !== 32) continue;
    if (
      !isAsciiLetter(found.charCodeAt(i)) ||
      !isAsciiLetter(found.charCodeAt(i + 1)) ||
      !isAsciiDigit(found.charCodeAt(i + 2)) ||
      !isAsciiDigit(found.charCodeAt(i + 3))
    ) {
      continue;
    }
    const country = found.slice(i, i + 2).toUpperCase();
    if (!Object.hasOwn(IBAN_LENGTHS, country)) continue;
    const length = IBAN_LENGTHS[country] as number;
    let compact = "";
    let j = i;
    while (compact.length < length && j < n) {
      if (found.charCodeAt(j) !== 32) compact += found.charAt(j);
      j++;
    }
    if (compact.length === length && ibanValid(compact)) return { start: i, end: j };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Card numbers

function digitAt(text: string, offset: number): number {
  const code = text.charCodeAt(offset);
  return code >= 48 && code <= 57 ? code - 48 : -1;
}

/** Digit group lengths of a card written in several groups ("4-6-5" is 4 digits, 6 digits, 5). */
const CARD_GROUP_SHAPES: ReadonlySet<string> = new Set([
  "4-4-4-4",
  "4-4-4-4-3",
  "4-6-5",
  "4-6-4",
  "4-4-4-1",
  "4-4-4-3",
]);

/**
 * Offset after the longest Luhn-valid window of 13 to 19 digits that starts at `start` (a group
 * start) and ends at the end of a digit group, or -1. A group is a run of digits between
 * separators (a space or a hyphen) or the ends of the text. A window of one group is any run of
 * 13 to 19 digits; a window of several groups must have one of the `CARD_GROUP_SHAPES`.
 */
function longestCardEnd(found: string, start: number): number {
  // Sums by index parity from the left; which parity doubles depends on the window length.
  const plain = [0, 0];
  const doubled = [0, 0];
  let best = -1;
  let offset = start;
  let shape = ""; // lengths of the closed groups, "4-4-"
  let groupLength = 0;
  for (let count = 1; ; count++) {
    const digit = digitAt(found, offset);
    groupLength++;
    const parity = (count - 1) & 1;
    plain[parity] = (plain[parity] as number) + digit;
    doubled[parity] = (doubled[parity] as number) + (DOUBLED[digit] as number);
    if (count >= 13) {
      const last = (count - 1) & 1;
      const total = (plain[last] as number) + (doubled[last ^ 1] as number);
      if (
        total % 10 === 0 &&
        digitAt(found, offset + 1) < 0 &&
        (shape === "" || CARD_GROUP_SHAPES.has(`${shape}${groupLength}`))
      ) {
        best = offset + 1;
      }
    }
    if (count === 19) break;
    let next = -1;
    if (digitAt(found, offset + 1) >= 0) next = offset + 1;
    else if (
      (found.charCodeAt(offset + 1) === 32 || found.charCodeAt(offset + 1) === 45) &&
      digitAt(found, offset + 2) >= 0
    ) {
      next = offset + 2;
      shape += `${groupLength}-`;
      groupLength = 0;
    }
    if (next < 0) break;
    offset = next;
  }
  return best;
}

/**
 * One forward pass over the group starts (the start of the text, or a digit right after a
 * separator): the first one that starts a Luhn-valid window opens a span, every valid window that
 * starts before the span's end can extend it, and a window that starts at or after the end begins
 * the next span (the caller resumes from there). A window never cuts a digit group, so an
 * unseparated run is a candidate only as a whole.
 */
function selectCard(found: string, from: number): ScrubSpan | null {
  const n = found.length;
  let spanStart = -1;
  let spanEnd = -1;
  for (let i = from; i < n; i++) {
    if (digitAt(found, i) < 0) continue;
    if (i > 0 && digitAt(found, i - 1) >= 0) continue; // inside a group
    if (spanStart >= 0 && i >= spanEnd) break;
    const end = longestCardEnd(found, i);
    if (spanStart < 0) {
      if (end >= 0) {
        spanStart = i;
        spanEnd = end;
      }
    } else if (end > spanEnd) {
      spanEnd = end;
    }
  }
  return spanStart < 0 ? null : { start: spanStart, end: spanEnd };
}

// ---------------------------------------------------------------------------------------------
// The rule list

/** Left boundary: not inside a longer token. */
const LB = "(?<![A-Za-z0-9_-])";

export const SCRUB_RULES: readonly ScrubRule[] = [
  {
    id: "private_key",
    // No `m` flag, so `$` is the end of the text: a block without an END line goes to the end.
    pattern:
      /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----|$)/g,
  },
  {
    id: "aws_access_key_id",
    pattern: /(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])/g,
  },
  {
    id: "github_token",
    pattern: new RegExp(`${LB}gh[pousr]_[A-Za-z0-9]{36,}|${LB}github_pat_[A-Za-z0-9_]{22,}`, "g"),
  },
  {
    id: "slack_token",
    pattern: new RegExp(`${LB}xox[abeoprs]-[A-Za-z0-9-]{10,}`, "g"),
  },
  {
    id: "anthropic_key",
    pattern: new RegExp(`${LB}sk-ant-[A-Za-z0-9_-]{20,}`, "g"),
  },
  {
    id: "openai_key",
    pattern: new RegExp(`${LB}sk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}`, "g"),
  },
  {
    id: "google_api_key",
    pattern: new RegExp(`${LB}AIza[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])`, "g"),
  },
  {
    id: "google_oauth_access_token",
    pattern: new RegExp(`${LB}ya29\\.[A-Za-z0-9_-]{40,}(?:\\.[A-Za-z0-9_-]+)*`, "g"),
  },
  {
    id: "google_oauth_refresh_token",
    pattern: new RegExp(`${LB}1//[A-Za-z0-9_-]{40,}`, "g"),
  },
  {
    id: "google_oauth_client_secret",
    pattern: new RegExp(`${LB}GOCSPX-[A-Za-z0-9_-]{24,}`, "g"),
  },
  {
    id: "stripe_secret_key",
    pattern: new RegExp(`${LB}(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}`, "g"),
  },
  {
    id: "jwt",
    pattern: new RegExp(
      `${LB}eyJ[A-Za-z0-9_-]{4,1024}\\.eyJ[A-Za-z0-9_-]{4,16384}\\.[A-Za-z0-9_-]{0,2048}(?![A-Za-z0-9_-])`,
      "g",
    ),
  },
  {
    id: "bearer",
    pattern: new RegExp(
      `(?<keep>${LB}bearer[ \\t]{1,20})(?<secret>[A-Za-z0-9._~+/-]{16,}=*)`,
      "gi",
    ),
  },
  {
    id: "labeled_secret",
    pattern: LABELED_PATTERN,
    tail: LABELED_TAIL,
    admit: (groups) => isLabelKey(groups.label ?? ""),
    select: selectLabeled,
  },
  {
    id: "iban",
    pattern: /(?<![A-Za-z0-9])[A-Za-z]{2}\d{2}(?: ?[A-Za-z0-9]){11,}/g,
    select: selectIban,
  },
  {
    id: "card_number",
    pattern: /(?<!\d)\d(?:[ -]?\d){12,}/g,
    select: selectCard,
  },
];
