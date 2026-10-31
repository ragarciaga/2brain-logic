import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  IBAN_LENGTHS,
  ibanValid,
  isLabelKey,
  isPlaceholder,
  luhnValid,
  SCRUB_RULES,
  ScrubError,
  type ScrubRule,
  scrub,
  scrubFrontmatter,
} from "../src/vault/scrub/index.js";

// Fixture secrets are synthetic and stored split into `parts` so that no contiguous secret
// format string exists in any file of this repository (CI runs gitleaks on every commit).

interface TextPositive {
  rule: string;
  parts: string[];
  expected: string;
  count?: number;
}
interface TextNegative {
  rule: string;
  parts: string[];
}
interface FrontmatterFixture {
  rule: string;
  field: string;
  kind: "string" | "number" | "bigint";
  parts: string[];
  expected?: string;
}
interface FixtureFile<T, F> {
  text: T[];
  frontmatter: F[];
}

const FIXTURE_DIR = new URL("./fixtures/scrub/", import.meta.url);
const readJson = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(name, FIXTURE_DIR), "utf8"));
const positive = readJson<FixtureFile<TextPositive, FrontmatterFixture>>("positive.json");
const negative = readJson<FixtureFile<TextNegative, FrontmatterFixture>>("negative.json");
const ibanExamples = readJson<Record<string, string[]>>("iban-examples.json");

const RULE_IDS =
  "private_key aws_access_key_id github_token slack_token anthropic_key openai_key google_api_key stripe_secret_key jwt bearer labeled_secret iban card_number".split(
    " ",
  );

const MARK = (id: string) => `[REDACTED:${id}]`;
const join = (...parts: string[]) => parts.join("");

/** The input of the nth positive text fixture of a rule. */
function inputOf(rule: string, nth = 0): string {
  const found = positive.text.filter((fixture) => fixture.rule === rule)[nth];
  if (!found) throw new Error(`no positive fixture ${nth} for ${rule}`);
  return found.parts.join("");
}

/** Just the secret of a single-hit positive fixture: the input without its surrounding text. */
function tokenOf(rule: string, nth = 0): string {
  const found = positive.text.filter((fixture) => fixture.rule === rule)[nth];
  if (!found) throw new Error(`no positive fixture ${nth} for ${rule}`);
  const input = found.parts.join("");
  const mark = MARK(found.rule);
  const at = found.expected.indexOf(mark);
  const suffix = found.expected.slice(at + mark.length);
  return input.slice(at, input.length - suffix.length);
}

function frontmatterValue(fixture: FrontmatterFixture): unknown {
  const raw = fixture.parts.join("");
  if (fixture.kind === "number") return Number(raw);
  if (fixture.kind === "bigint") return BigInt(raw);
  return raw;
}

function ruleById(id: string): ScrubRule {
  const rule = SCRUB_RULES.find((candidate) => candidate.id === id);
  if (!rule) throw new Error(`no rule ${id}`);
  return rule;
}

describe("rule list (R4.2)", () => {
  it("has exactly the 13 rules, in order, with unique ids and global patterns", () => {
    expect(SCRUB_RULES.map((rule) => rule.id)).toEqual(RULE_IDS);
    expect(new Set(SCRUB_RULES.map((rule) => rule.id)).size).toBe(RULE_IDS.length);
    for (const rule of SCRUB_RULES) {
      expect(rule.id).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(rule.pattern.global).toBe(true);
    }
  });

  it("scans a private key block with the g flag only, so a missing END line ends at the text end", () => {
    expect(ruleById("private_key").pattern.flags).toBe("g");
  });

  it.each(RULE_IDS)("%s has at least one positive and one negative text fixture", (id) => {
    expect(positive.text.some((fixture) => fixture.rule === id)).toBe(true);
    expect(negative.text.some((fixture) => fixture.rule === id)).toBe(true);
  });

  it("only names rules that exist", () => {
    for (const fixture of [...positive.text, ...negative.text]) {
      expect(RULE_IDS).toContain(fixture.rule);
    }
  });
});

describe("text positives (R4.1, R4.2, D1)", () => {
  it.each(positive.text.map((fixture, index) => [index, fixture.rule, fixture] as const))(
    "#%i %s is redacted with the exact output and hit count",
    (_index, _rule, fixture) => {
      const result = scrub(fixture.parts.join(""));
      expect(result.text).toBe(fixture.expected);
      expect([...result.hits]).toEqual([[fixture.rule, fixture.count ?? 1]]);
    },
  );

  it.each(positive.text.map((fixture, index) => [index, fixture.rule, fixture] as const))(
    "#%i %s is idempotent on its redacted text",
    (_index, _rule, fixture) => {
      const again = scrub(fixture.expected);
      expect(again.text).toBe(fixture.expected);
      expect(again.hits.size).toBe(0);
    },
  );

  it("is idempotent when every positive is scrubbed in one document", () => {
    const document = positive.text.map((fixture) => fixture.parts.join("")).join("\n\n");
    const once = scrub(document);
    const twice = scrub(once.text);
    expect(twice.text).toBe(once.text);
    expect(twice.hits.size).toBe(0);
    expect(once.hits.size).toBeGreaterThan(0);
  });
});

describe("text negatives (R4.2)", () => {
  it.each(negative.text.map((fixture, index) => [index, fixture.rule, fixture] as const))(
    "#%i %s is left alone",
    (_index, _rule, fixture) => {
      const input = fixture.parts.join("");
      const result = scrub(input);
      expect(result.text).toBe(input);
      expect(result.hits.size).toBe(0);
    },
  );

  it("reports no hits for plain text (hits only for counts above 0)", () => {
    const result = scrub("Meeting notes from Tuesday, nothing sensitive here.");
    expect(result.hits.size).toBe(0);
    expect(result.text).toBe("Meeting notes from Tuesday, nothing sensitive here.");
  });
});

describe("overlap, order and boundaries (D2, D6)", () => {
  it("an sk-ant key is the Anthropic rule, not the OpenAI one", () => {
    const result = scrub(inputOf("anthropic_key"));
    expect(result.hits.get("anthropic_key")).toBe(1);
    expect(result.hits.has("openai_key")).toBe(false);
  });

  it("a JWT after Bearer is the JWT rule, not the Bearer rule", () => {
    const result = scrub(inputOf("jwt", 3));
    expect([...result.hits]).toEqual([["jwt", 1]]);
  });

  it("an IBAN is not also a card number", () => {
    const result = scrub(inputOf("iban"));
    expect([...result.hits]).toEqual([["iban", 1]]);
  });

  it("a provider token under a label gives the provider rule", () => {
    const result = scrub(inputOf("github_token", 3));
    expect(result.text).toBe(`${join("to", "ken: ")}${MARK("github_token")}`);
    expect([...result.hits]).toEqual([["github_token", 1]]);
  });

  it("redacts a valid IBAN followed by more alphanumerics and keeps the trailing characters", () => {
    const result = scrub(`acct ${join("DE89", "3704", "0044", "0532", "0130", "00")}X1`);
    expect(result.text).toBe(`acct ${MARK("iban")}X1`);
  });

  it("redacts a second IBAN after words and an IBAN after a non-IBAN prefix", () => {
    const first = join("DE89", " 3704 0044 0532 ", "0130 00");
    const second = join("FR76", " 3000 6000 0112 ", "3456 7890 189");
    expect(scrub(`move EUR 500 from ${first} to ${second}`).text).toBe(
      `move EUR 500 from ${MARK("iban")} to ${MARK("iban")}`,
    );
    expect(scrub(`ref ${join("AB", "12")} ${first}`).text).toBe(
      `ref ${join("AB", "12")} ${MARK("iban")}`,
    );
  });

  it("requires the country code and the check digits to be contiguous", () => {
    const text = join("NL ", "91 ABNA 0417 1643 00");
    expect(scrub(text).text).toBe(text);
  });

  it("does not start an IBAN in the middle of a word", () => {
    const glued = join("AB", "12", "DE89", "3704", "0044", "0532", "0130", "00");
    // Only the IBAN rule runs: the card rule would redact the digit tail of the glued word.
    const result = scrub(`acct ${glued} end`, [ruleById("iban")]);
    expect(result.text).toBe(`acct ${glued} end`);
    expect(result.hits.size).toBe(0);
  });

  it("applies a custom rule list", () => {
    const only = scrub(tokenOf("aws_access_key_id"), [ruleById("github_token")]);
    expect(only.hits.size).toBe(0);
  });
});

/** The group lengths a card of several groups may have; a single group has 13 to 19 digits. */
const CARD_SHAPES = ["4-4-4-4", "4-4-4-4-3", "4-6-5", "4-6-4", "4-4-4-1", "4-4-4-3"];

/**
 * Independent brute force for the card rule: every Luhn-valid window of 13 to 19 digits that
 * starts at the start of a digit run or right after a separator, ends at the end of the run or
 * right before a separator, and whose group lengths are a single group or one of CARD_SHAPES.
 */
function cardOracle(input: string): { text: string; count: number } {
  const luhn = (digits: number[]) => {
    let sum = 0;
    for (let i = 0; i < digits.length; i++) {
      let d = digits[digits.length - 1 - i] as number;
      if (i % 2 === 1) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
    }
    return sum % 10 === 0;
  };
  let out = "";
  let last = 0;
  let count = 0;
  for (const run of input.matchAll(/(?<!\d)\d(?:[ -]?\d)*/g)) {
    const offsets: number[] = [];
    const digits: number[] = [];
    const text = run[0];
    for (let i = 0; i < text.length; i++) {
      const ch = text.charAt(i);
      if (ch >= "0" && ch <= "9") {
        offsets.push((run.index ?? 0) + i);
        digits.push(Number(ch));
      }
    }
    if (digits.length < 13) continue;
    // Digit index k starts a group when a separator sits before it; index e ends one likewise.
    const groupStart = (k: number) =>
      k === 0 || (offsets[k] as number) - (offsets[k - 1] as number) > 1;
    const groupEnd = (e: number) =>
      e === digits.length || (offsets[e] as number) - (offsets[e - 1] as number) > 1;
    const merged: Array<[number, number]> = [];
    for (let start = 0; start < digits.length; start++) {
      if (!groupStart(start)) continue;
      let end = -1;
      for (let len = 13; len <= 19 && start + len <= digits.length; len++) {
        if (!groupEnd(start + len) || !luhn(digits.slice(start, start + len))) continue;
        const lengths = [1];
        for (let k = start + 1; k < start + len; k++) {
          if (groupStart(k)) lengths.push(1);
          else lengths[lengths.length - 1] = (lengths[lengths.length - 1] as number) + 1;
        }
        if (lengths.length === 1 || CARD_SHAPES.includes(lengths.join("-"))) end = start + len;
      }
      if (end < 0) continue;
      const current = merged[merged.length - 1];
      if (current && start < current[1]) current[1] = Math.max(current[1], end);
      else merged.push([start, end]);
    }
    for (const [start, end] of merged) {
      out += input.slice(last, offsets[start]) + MARK("card_number");
      last = (offsets[end - 1] as number) + 1;
      count++;
    }
  }
  return { text: out + input.slice(last), count };
}

describe("card windows (D6)", () => {
  const cardRule = ruleById("card_number");

  // mulberry32
  const seeded = (seed: number) => {
    let state = seed;
    return (limit: number) => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return (((t ^ (t >>> 14)) >>> 0) % limit) | 0;
    };
  };
  const luhnOk = (digits: string) => {
    let sum = 0;
    for (let i = 0; i < digits.length; i++) {
      let d = Number(digits.charAt(digits.length - 1 - i));
      if (i % 2 === 1) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
    }
    return sum % 10 === 0;
  };
  /** Random digits in the given group lengths; `valid` fixes the last digit so Luhn holds. */
  const grouped = (next: (limit: number) => number, lengths: number[], valid: boolean) => {
    let digits = "";
    for (const length of lengths) for (let i = 0; i < length; i++) digits += String(next(10));
    if (valid) {
      const head = digits.slice(0, -1);
      const last = [...Array(10).keys()].find((d) => luhnOk(`${head}${d}`));
      digits = `${head}${last}`;
    }
    const parts: string[] = [];
    let at = 0;
    for (const length of lengths) {
      parts.push(digits.slice(at, at + length));
      at += length;
    }
    return parts;
  };

  it("matches a brute-force oracle on seeded random digit runs", () => {
    const next = seeded(20241031);
    const separators = ["", "", "", " ", "-"];
    let redacted = 0;
    for (let round = 0; round < 400; round++) {
      let input = "";
      const groups = 1 + next(4);
      for (let g = 0; g < groups; g++) {
        const length = 1 + next(40);
        for (let i = 0; i < length; i++) {
          input += String(next(10));
          if (i < length - 1) input += separators[next(separators.length)] as string;
        }
        input += g < groups - 1 ? " ab " : "";
      }
      const expected = cardOracle(input);
      const actual = scrub(input, [cardRule]);
      expect(actual.text).toBe(expected.text);
      expect(actual.hits.get("card_number") ?? 0).toBe(expected.count);
    }
    // Runs in card-like groupings, valid and not, on both sides of the shape whitelist.
    const shapes = [
      [16],
      [13],
      [19],
      [4, 4, 4, 4],
      [4, 4, 4, 4, 3],
      [4, 6, 5],
      [4, 6, 4],
      [4, 4, 4, 1],
      [4, 4, 4, 3],
      [4, 4, 4, 4, 4],
      [4, 4, 4],
      [3, 3, 3, 3, 4],
      [5, 5, 5],
      [6, 6, 6],
      [2, 4, 4, 4, 2],
      [3, 7, 7],
      [4, 5, 6],
      [4, 4, 8],
    ];
    for (let round = 0; round < 600; round++) {
      const lengths = shapes[next(shapes.length)] as number[];
      const joiner = [" ", "-"][next(2)] as string;
      const input = `ref ${grouped(next, lengths, next(2) === 0).join(joiner)} ok`;
      const expected = cardOracle(input);
      const actual = scrub(input, [cardRule]);
      expect(actual.text).toBe(expected.text);
      expect(actual.hits.get("card_number") ?? 0).toBe(expected.count);
      redacted += expected.count;
    }
    expect(redacted).toBeGreaterThan(100);
  });

  it("starts the next span at the group that follows the end of the previous one", () => {
    // Two Luhn-valid 16-digit cards in 8 groups: no valid window crosses the middle, so the first
    // span ends at the fourth group and the second one starts at the fifth.
    const input = join("8628", " 8220", " 0420", " 2000", " 4036", " 4688", " 4628", " 2266");
    expect(cardOracle(input).count).toBe(2);
    const result = scrub(input, [cardRule]);
    expect(result.text).toBe(`${MARK("card_number")} ${MARK("card_number")}`);
    expect(result.hits.get("card_number")).toBe(2);
  });

  it("never cuts a digit group: an unseparated run is a candidate only as a whole", () => {
    // 27 contiguous digits hold Luhn-valid windows of 13 to 19 digits inside, but the run as a
    // whole is longer than 19 digits, so nothing is redacted.
    const long = join("4262", "2844", "4493", "4771", "3228", "6329", "523");
    const inner = [...long.slice(0, 14)].map((_, at) => long.slice(at, at + 13)).filter(luhnValid);
    expect(inner.length).toBeGreaterThan(0);
    const result = scrub(long, [cardRule]);
    expect(result.text).toBe(long);
    expect(result.hits.size).toBe(0);
  });

  it("leaves Luhn-failing runs alone, unseparated and grouped, on seeded random digits", () => {
    let state = 31102026;
    const next = (limit: number) => {
      // mulberry32
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return (((t ^ (t >>> 14)) >>> 0) % limit) | 0;
    };
    const luhnOk = (digits: string) => {
      let sum = 0;
      for (let i = 0; i < digits.length; i++) {
        let d = Number(digits.charAt(digits.length - 1 - i));
        if (i % 2 === 1) {
          d *= 2;
          if (d > 9) d -= 9;
        }
        sum += d;
      }
      return sum % 10 === 0;
    };
    const randomDigits = (length: number) => {
      let out = "";
      for (let i = 0; i < length; i++) out += String(next(10));
      return out;
    };
    const fours = (digits: string) => (digits.match(/\d{1,4}/g) ?? []).join(" ");
    for (const length of [16, 19]) {
      let plain = 0;
      let grouped = 0;
      for (let round = 0; round < 5000 && (plain < 200 || grouped < 200); round++) {
        const digits = randomDigits(length);
        if (luhnOk(digits)) continue;
        if (plain < 200) {
          plain++;
          expect(scrub(`ref ${digits} ok`, [cardRule]).text).toBe(`ref ${digits} ok`);
        }
        const spaced = fours(digits);
        // A 19-digit run in groups of four also holds shorter aligned windows (16 and 15 digits).
        if (grouped < 200 && cardOracle(spaced).count === 0) {
          grouped++;
          expect(scrub(`ref ${spaced} ok`, [cardRule]).text).toBe(`ref ${spaced} ok`);
        }
      }
      expect(plain).toBe(200);
      expect(grouped).toBe(200);
    }
  });

  it("leaves runs in groupings outside the whitelist alone, Luhn-valid or not", () => {
    const next = seeded(20261031);
    const outside = [
      [3, 3, 3, 3, 4],
      [2, 4, 4, 4, 2],
      [5, 5, 5, 5],
      [6, 6, 6, 6],
      [3, 7, 7],
      [3, 3, 4, 3, 3, 4],
    ];
    for (const lengths of outside) {
      let valid = 0;
      for (let round = 0; round < 300; round++) {
        const makeValid = round % 2 === 0;
        const parts = grouped(next, lengths, makeValid);
        const input = `ref ${parts.join([" ", "-"][next(2)] as string)} ok`;
        // A sub-window can be card-shaped (3-3-4-3-3-4 holds none, but check the oracle anyway).
        expect(cardOracle(input).count).toBe(0);
        expect(scrub(input, [cardRule]).text).toBe(input);
        if (makeValid && luhnOk(parts.join(""))) valid++;
      }
      expect(valid).toBe(150);
    }
  });

  it("redacts each whitelisted grouping of a Luhn-valid card", () => {
    const next = seeded(7102026);
    const inside = [
      [13],
      [16],
      [19],
      [4, 4, 4, 4],
      [4, 4, 4, 4, 3],
      [4, 6, 5],
      [4, 6, 4],
      [4, 4, 4, 1],
      [4, 4, 4, 3],
    ];
    for (const lengths of inside) {
      for (let round = 0; round < 20; round++) {
        const joiner = [" ", "-"][next(2)] as string;
        const input = `ref ${grouped(next, lengths, true).join(joiner)} ok`;
        expect(scrub(input, [cardRule]).text).toBe(`ref ${MARK("card_number")} ok`);
      }
    }
  });
});

describe("labeled values", () => {
  it("redacts an unterminated quoted value to the end of its line only", () => {
    const fixture = positive.text.find((f) => f.parts[1] === 'word="');
    expect(fixture).toBeDefined();
    const input = fixture?.parts.join("") ?? "";
    expect(input.length).toBeGreaterThan(5000);
    const result = scrub(input);
    expect(result.text).toBe(`${join("pass", 'word="')}${MARK("labeled_secret")}\nnext line\n`);
  });

  const label = join("pass", "word");

  it("redacts an unquoted value of exactly 6 characters and keeps one of 5", () => {
    const six = scrub(`${label}: ${join("abc", "def")}`);
    expect(six.text).toBe(`${label}: ${MARK("labeled_secret")}`);
    expect([...six.hits]).toEqual([["labeled_secret", 1]]);
    const five = `${label}: ${join("abc", "de")}`;
    const kept = scrub(five);
    expect(kept.text).toBe(five);
    expect(kept.hits.size).toBe(0);
  });

  it.each(['"', "'", "`"])(
    "redacts a %s quoted value of exactly 6 characters and keeps one of 5",
    (quote) => {
      const six = scrub(`${label}: ${quote}${join("abc", "def")}${quote} end`);
      expect(six.text).toBe(`${label}: ${quote}${MARK("labeled_secret")}${quote} end`);
      expect([...six.hits]).toEqual([["labeled_secret", 1]]);
      const five = `${label}: ${quote}${join("abc", "de")}${quote} end`;
      const kept = scrub(five);
      expect(kept.text).toBe(five);
      expect(kept.hits.size).toBe(0);
    },
  );

  it.each(['"', "'", "`"])(
    "redacts an unterminated %s value of exactly 6 characters and keeps one of 5",
    (quote) => {
      const six = scrub(`${label}=${quote}${join("abc", "def")}\nnext`);
      expect(six.text).toBe(`${label}=${quote}${MARK("labeled_secret")}\nnext`);
      expect([...six.hits]).toEqual([["labeled_secret", 1]]);
      const five = `${label}=${quote}${join("abc", "de")}\nnext`;
      const kept = scrub(five);
      expect(kept.text).toBe(five);
      expect(kept.hits.size).toBe(0);
    },
  );

  it.each(['"', "'", "`"])("redacts a %s quoted value longer than 4096 characters", (quote) => {
    const value = "a1b2c3d4e5".repeat(500);
    const result = scrub(`${join("to", "ken")}=${quote}${value}${quote} tail`);
    expect(result.text).toBe(`${join("to", "ken")}=${quote}${MARK("labeled_secret")}${quote} tail`);
    expect([...result.hits]).toEqual([["labeled_secret", 1]]);
  });

  it("honors a backslash escape of the quote and of the backslash in a quoted value", () => {
    const key = join("pass", "word");
    const escaped = scrub(`${key}="${join("abc", '\\"', "defghi")}" next`);
    expect(escaped.text).toBe(`${key}="${MARK("labeled_secret")}" next`);
    // An even number of backslashes before the quote means the quote closes the value.
    const closed = scrub(`${key}="${join("abcdef", "\\\\")}" next`);
    expect(closed.text).toBe(`${key}="${MARK("labeled_secret")}" next`);
  });

  it("redacts an unterminated value that ends in an escaped quote, quote included", () => {
    const key = join("pass", "word");
    const result = scrub(`${key}="${join("abcdef", '\\"')}\nnext`);
    expect(result.text).toBe(`${key}="${MARK("labeled_secret")}\nnext`);
  });

  it("keeps the quotes around a redacted quoted value", () => {
    const input = `${join("pass", "word")}: "${join("hunter", "2xyz")}" and more`;
    expect(scrub(input).text).toBe(`${join("pass", "word")}: "${MARK("labeled_secret")}" and more`);
  });

  it("redacts a quoted value that closes within 5 characters and runs on (YAML, shell, SQL)", () => {
    const secret = join("abcd1234", "efgh");
    const upper = join("PASS", "WORD");
    const shapes: Array<[string, string]> = [
      [`${label}: 'it''s-${secret}'`, `${label}: '${MARK("labeled_secret")}'`],
      [`${upper}='it'\\''s-${secret}'`, `${upper}='${MARK("labeled_secret")}'`],
      [`${label}: 'O'Brien-${secret}'`, `${label}: '${MARK("labeled_secret")}'`],
      [`${label}="ab""${secret}"`, `${label}="${MARK("labeled_secret")}"`],
      [`${label}=\`ab\`\`${secret}\``, `${label}=\`${MARK("labeled_secret")}\``],
      [`${label}="abcde"fghijk`, `${label}="${MARK("labeled_secret")}`],
      [`${label}='' ${secret}`, `${label}='' ${secret}`],
    ];
    for (const [input, expected] of shapes) expect(scrub(input).text).toBe(expected);
  });

  it("keeps a quoted value that is closed within 5 characters when fewer than 5 follow", () => {
    for (const input of [
      `${label}='ab'cde`,
      `{"${label}":"abc"}`,
      `${label}="abcde", "other":1`,
      `${label}='ab' and more things`,
    ]) {
      const result = scrub(input);
      expect(result.text).toBe(input);
      expect(result.hits.size).toBe(0);
    }
  });

  it("redacts a value inside a JSON string that was encoded twice, up to its escaped quote", () => {
    const secret = join("abcd1234", "efgh5678");
    const input = `{\\"${label}\\":\\"${secret}\\",\\"user\\":\\"bob\\"}`;
    const result = scrub(input);
    expect(result.text).toBe(
      `{\\"${label}\\":\\"${MARK("labeled_secret")}\\",\\"user\\":\\"bob\\"}`,
    );
    expect([...result.hits]).toEqual([["labeled_secret", 1]]);
    const single = scrub(`{\\'${label}\\': \\'${secret}\\'}`);
    expect(single.text).toBe(`{\\'${label}\\': \\'${MARK("labeled_secret")}\\'}`);
    // Without a closing escaped quote on the line, the value runs to the end of the line.
    expect(scrub(`${label}=\\"${secret}\nnext`).text).toBe(
      `${label}=\\"${MARK("labeled_secret")}\nnext`,
    );
    // A value that is too short, or already redacted, is kept.
    for (const kept of [
      `{\\"${label}\\":\\"abc\\"}`,
      `{\\"${label}\\":\\"${MARK("labeled_secret")}\\"}`,
    ]) {
      expect(scrub(kept).text).toBe(kept);
    }
  });

  it("finds a labeled secret inside the value of a label that names something else", () => {
    const secret = join("hunter", "2xyz");
    const input = `url=https://host.example.com/?${label}=${secret} and ${join("to", "ken")}_count=1234567`;
    expect(scrub(input).text).toBe(
      `url=https://host.example.com/?${label}=${MARK("labeled_secret")} and ${join("to", "ken")}_count=1234567`,
    );
    const quoted = scrub(`cmd="run --${label}=${secret} now"`);
    expect(quoted.text).toBe(`cmd="run --${label}=${MARK("labeled_secret")} now"`);
    expect([...quoted.hits]).toEqual([["labeled_secret", 1]]);
    // Several nested secrets in one value are all found, each counted once.
    const several = scrub(`note="a ${label}=${secret} b ${label}: ${secret}2 c"`);
    expect(several.hits.get("labeled_secret")).toBe(2);
    expect(several.text).not.toContain(secret);
  });

  it("finds a labeled secret after any number of non-secret assignments in the same run", () => {
    const secret = join("hunter", "2xyz", "abcd");
    const key = join("pass", "word");
    const params = (count: number) =>
      Array.from({ length: count }, (_unused, i) => `k${i}=abcdef`).join("&");
    const json = `{${Array.from({ length: 40 }, (_unused, i) => `"k${i}":"abcdef"`).join(",")},"${key}":"${secret}"}`;
    const url = `https://host.example.com/?${params(40)}&${key}=${secret}`;
    const options = `run ${Array.from({ length: 40 }, (_unused, i) => `--o${i}=abcdef`).join(" ")} --${key}=${secret}`;
    const cases: Array<[string, string]> = [
      [json, json.replace(secret, MARK("labeled_secret"))],
      [url, url.replace(secret, MARK("labeled_secret"))],
      [`url=${url}`, `url=${url.replace(secret, MARK("labeled_secret"))}`],
      [options, options.replace(secret, MARK("labeled_secret"))],
      // A long run of rejected assignments that all sit inside one quoted value.
      [
        `cmd="${params(500)}&${key}=${secret}"`,
        `cmd="${params(500)}&${key}=${MARK("labeled_secret")}"`,
      ],
    ];
    for (const [input, expected] of cases) {
      const result = scrub(input);
      expect(result.text).toBe(expected);
      expect([...result.hits]).toEqual([["labeled_secret", 1]]);
    }
  });

  it("keeps a quoted value closed within 5 characters when exactly 4 characters follow, and redacts at 5", () => {
    const kept = `${label}='ab'${join("cd", "ef")}`;
    const four = scrub(kept);
    expect(four.text).toBe(kept);
    expect(four.hits.size).toBe(0);
    const five = scrub(`${label}='ab'${join("cd", "efg")}`);
    expect(five.text).toBe(`${label}='${MARK("labeled_secret")}`);
    expect([...five.hits]).toEqual([["labeled_secret", 1]]);
  });

  it("reads a single-word compound that ends with a secret word as a label", () => {
    const secret = join("abcd1234", "efgh");
    for (const name of [
      join("PG", "PASSWORD"),
      join("AUTH", "TOKEN"),
      join("auth", "token"),
      join("client", "secret"),
      join("secret", "key"),
      join("api", "token"),
      join("access", "token"),
      join("my", "password"),
      join("user", "pwd"),
      join("github", "token"),
      join("x", "token"),
      join("access", "key"),
      join("private", "key"),
    ]) {
      expect(scrub(`${name}=${secret}`).text).toBe(`${name}=${MARK("labeled_secret")}`);
      expect(scrub(`${name}: ${secret}`).text).toBe(`${name}: ${MARK("labeled_secret")}`);
      // The same key in frontmatter marks its value, whatever the value looks like.
      expect(scrubFrontmatter({ [name]: "two words" }).data).toEqual({
        [name]: MARK("labeled_secret"),
      });
    }
    for (const name of [
      join("secre", "tary"),
      join("to", "kenizer"),
      join("pass", "wordless"),
      join("to", "kens"),
      join("mon", "key"),
      join("key", "board"),
      join("sort_", "key"),
      join("my", "token", "_count"),
    ]) {
      expect(scrub(`${name}=${secret}`).text).toBe(`${name}=${secret}`);
      expect(scrubFrontmatter({ [name]: "two words" }).data).toEqual({ [name]: "two words" });
    }
  });

  it("reads the label by its words: spelling variants of a secret label are labels", () => {
    const secret = join("abcd1234", "efgh");
    for (const name of [
      join("db", "PasswordProd"),
      join("DB_PASS", "WORD_US_EAST_1"),
      join("secret", "KeyBase"),
      join("AWS", "SecretKey"),
      join("x.api", ".key"),
      join("my pass", "word is"),
    ]) {
      expect(scrub(`${name}: ${secret}`).text).toBe(`${name}: ${MARK("labeled_secret")}`);
    }
    for (const name of [
      join("max_to", "kens"),
      join("DB_PASS", "WORD_URL"),
      join("secre", "tary"),
    ]) {
      expect(scrub(`${name}: ${secret}`).text).toBe(`${name}: ${secret}`);
    }
  });

  it("reads a one-word label that ends in a key word or in credential(s) as a label", () => {
    const secret = join("abcd1234", "efgh");
    for (const name of [
      join("secretaccess", "key"),
      join("AWS", "SECRETACCESSKEY"),
      join("aws_", "secretaccesskey"),
      join("my", "apikey"),
      join("GOOGLE", "APIKEY"),
      join("OPENAI", "APIKEY"),
      join("my", "secretkey"),
      join("STRIPE", "SECRETKEY"),
      join("aws", "accesskey"),
      join("ssh", "privatekey"),
      join("db", "credentials"),
      join("client", "credentials"),
      join("user", "credential"),
      join("token", "key"),
      join("my", "apikey2"),
      join("my", "apikey_prod"),
      join("MYAPI", "_KEY"),
      join("xaccess", "_key"),
      join("xprivate", "_key"),
    ]) {
      expect(scrub(`${name}=${secret}`).text).toBe(`${name}=${MARK("labeled_secret")}`);
      expect(scrub(`${name}: ${secret}`).text).toBe(`${name}: ${MARK("labeled_secret")}`);
      expect(scrubFrontmatter({ [name]: "two words" }).data).toEqual({
        [name]: MARK("labeled_secret"),
      });
    }
    for (const name of [
      join("mon", "key"),
      join("sort", "_key"),
      join("secre", "tary"),
      join("to", "kenizer"),
      join("max_to", "kens"),
      join("pass", "word_policy"),
      join("api_key", "_name"),
      join("to", "ken_count"),
      join("DB_PASS", "WORD_URL"),
      join("key", "board"),
      join("my", "apikey_name"),
      join("db", "credentials_url"),
    ]) {
      expect(scrub(`${name}=${secret}`).text).toBe(`${name}=${secret}`);
      expect(scrubFrontmatter({ [name]: "two words" }).data).toEqual({ [name]: "two words" });
    }
  });

  it("pins the := and => separators", () => {
    const pass = join("pass", "word");
    const token = join("to", "ken");
    // A value of 6 or more characters after := keeps the separator.
    expect(scrub(`${pass}:=${join("abc", "def")}`).text).toBe(`${pass}:=${MARK("labeled_secret")}`);
    expect(scrub(`${pass} := ${join("abcd", "efgh")}`).text).toBe(
      `${pass} := ${MARK("labeled_secret")}`,
    );
    // With 5 characters after :=, the = is part of the value (the head backs off to ":").
    expect(scrub(`${pass}:=${join("abc", "de")}`).text).toBe(`${pass}:${MARK("labeled_secret")}`);
    expect(scrub(`${token} => ${join("abcd", "efgh")}`).text).toBe(
      `${token} => ${MARK("labeled_secret")}`,
    );
    expect(scrub(`${token}=>${join("abcd", "efgh")}`).text).toBe(
      `${token}=>${MARK("labeled_secret")}`,
    );
    expect(scrub(`${token} =>${join("abc", "de")}`).text).toBe(
      `${token} =${MARK("labeled_secret")}`,
    );
  });
});

describe("label sweep over the shapes of the previous grammar (Revisions 8 and 9)", () => {
  // The label grammar of 4e528b7 was one regex, case-insensitive: a core word (or `api`, `access`,
  // `private` with an optional joiner and `key`), an optional `key` or `access key` suffix and an
  // optional tail, with no left boundary. The shapes below are the product of those parts in
  // eight casings, four regular ones and four seeded per-letter ones that put humps inside the
  // core words (`passWord`, `PWd`, `PASSWord`). The product was run through that head: it
  // redacted every shape as text, and every shape as a frontmatter key except those flagged
  // `inFrontmatter: false`. All of those must still be redacted; nothing is left out.
  const PREFIXES = ["", "my", "AWS_", "the ", "A1"];
  const JOINS = ["", " ", "_", "-"];
  const CORES = [
    join("pass", "word"),
    join("pass", "wd"),
    "pwd",
    join("pass", "phrase"),
    join("sec", "ret"),
    join("to", "ken"),
    "credential",
    "credentials",
    ...["api", "access", "private"].flatMap((word) => JOINS.map((joiner) => `${word}${joiner}key`)),
  ];
  const SUFFIXES = [
    "",
    ...["", " ", "_", ".", "-"].flatMap((joiner) =>
      ["key", ...JOINS.map((inner) => `access${inner}key`)].map((rest) => `${joiner}${rest}`),
    ),
  ];
  const TAILS = ["", "_prod", ".v2", "-ro", "_a_b", "1", "123", "_abcdefghijkl"];
  const capitalize = (text: string) =>
    text.replace(
      /(^|[ _.-])([a-z])/g,
      (_all, edge: string, letter: string) => edge + letter.toUpperCase(),
    );
  // A fixed linear congruential generator: the same casings on every run.
  let state = 20260431;
  const chance = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  const perLetter = (upperShare: number) => (body: string, tail: string) =>
    [...(body + tail)]
      .map((letter) => (chance() < upperShare ? letter.toUpperCase() : letter.toLowerCase()))
      .join("");
  const CASINGS: Record<string, (body: string, tail: string) => string> = {
    lower: (body, tail) => body + tail,
    upper: (body, tail) => (body + tail).toUpperCase(),
    title: (body, tail) => capitalize(body + tail),
    camel: (body, tail) =>
      capitalize(body)
        .replace(/[ _.-]+/g, "")
        .replace(/^[A-Z]/, (letter) => letter.toLowerCase()) + tail,
    mixedFew: perLetter(0.3),
    mixedHalf: perLetter(0.5),
    mixedMost: perLetter(0.7),
    mixedHalfAgain: perLetter(0.5),
  };

  interface Shape {
    label: string;
    inFrontmatter: boolean;
  }
  function* shapes(): Generator<Shape> {
    for (const prefix of PREFIXES) {
      for (const core of CORES) {
        for (const suffix of SUFFIXES) {
          for (const tail of TAILS) {
            for (const [casing, apply] of Object.entries(CASINGS)) {
              yield {
                label: apply(`${prefix}${core}${suffix}`, tail),
                // The previous frontmatter key pattern had no space in its left part.
                inFrontmatter: !(prefix.includes(" ") && casing !== "camel"),
              };
            }
          }
        }
      }
    }
  }

  it("redacts every shape that the previous grammar redacted, as text and as a key", () => {
    const value = join("k3Vq9x", "Lm2Pz7", "Rt4W");
    const textMisses: string[] = [];
    const keyMisses: string[] = [];
    let checked = 0;
    for (const { label, inFrontmatter } of shapes()) {
      checked++;
      if (scrub(`${label}=${value}`).text !== `${label}=${MARK("labeled_secret")}`) {
        textMisses.push(label);
      }
      if (inFrontmatter) {
        const data = scrubFrontmatter({ [label]: "two words" }).data;
        if (data[label] !== MARK("labeled_secret")) keyMisses.push(label);
      }
    }
    expect(checked).toBeGreaterThan(0);
    expect(textMisses.slice(0, 10)).toEqual([]);
    expect(keyMisses.slice(0, 10)).toEqual([]);
  }, 120_000);

  it("keeps the shapes the sweep names: a hump inside a core word, a doubled key, a long last word", () => {
    const value = join("k3Vq9x", "Lm2Pz7", "Rt4W");
    for (const label of [
      join("pass", "Word"),
      join("Pass", "Word"),
      join("pass", "Phrase"),
      join("Pass", "Phrase"),
      join("pass", "Wd"),
      join("P", "Wd"),
      join("PASS", "Word"),
      join("Key", "Pass", "Phrase"),
      join("ssh", "Pass", "Phrase"),
      join("api", "keykey"),
      join("API_", "KEYKEY_PROD"),
      join("APIKEY", "KEY_PROD"),
      join("API Key_", "abcdefghijkl"),
      join("my API Key_", "abcdefghijklmnopqrstuvwxyz"),
    ]) {
      expect(scrub(`${label}=${value}`).text).toBe(`${label}=${MARK("labeled_secret")}`);
      expect(scrubFrontmatter({ [label]: "two words" }).data).toEqual({
        [label]: MARK("labeled_secret"),
      });
    }
  });
});

describe("scrubFrontmatter (R4.1)", () => {
  it.each(
    positive.frontmatter.map(
      (fixture) => [fixture.rule, fixture.field, fixture.kind, fixture] as const,
    ),
  )("%s in %s (%s) is redacted", (_rule, _field, _kind, fixture) => {
    const input = { [fixture.field]: frontmatterValue(fixture) };
    const result = scrubFrontmatter(input);
    expect(result.data).toEqual({ [fixture.field]: fixture.expected ?? MARK(fixture.rule) });
    expect([...result.hits]).toEqual([[fixture.rule, 1]]);
  });

  it.each(
    negative.frontmatter.map(
      (fixture) => [fixture.rule, fixture.field, fixture.kind, fixture] as const,
    ),
  )("%s in %s (%s) comes back unchanged", (_rule, _field, _kind, fixture) => {
    const input = { [fixture.field]: frontmatterValue(fixture) };
    const result = scrubFrontmatter(input);
    expect(result.data).toEqual(input);
    expect(typeof result.data[fixture.field]).toBe(typeof input[fixture.field]);
    expect(result.hits.size).toBe(0);
  });

  it("replaces matches in every string of a nested object, arrays included, and sums the hits", () => {
    const github = tokenOf("github_token");
    const aws = tokenOf("aws_access_key_id");
    const input = {
      title: "A plain title",
      nested: { deep: { note: `see ${github} now`, list: [aws, "fine", [aws]] } },
      top: [`${github}`, { inner: aws }],
    };
    const result = scrubFrontmatter(input);
    expect(result.data).toEqual({
      title: "A plain title",
      nested: {
        deep: {
          note: `see ${MARK("github_token")} now`,
          list: [MARK("aws_access_key_id"), "fine", [MARK("aws_access_key_id")]],
        },
      },
      top: [MARK("github_token"), { inner: MARK("aws_access_key_id") }],
    });
    expect(result.hits.get("github_token")).toBe(2);
    expect(result.hits.get("aws_access_key_id")).toBe(3);
  });

  it("leaves booleans, null, undefined, non-finite numbers, Dates and other objects untouched", () => {
    const when = new Date(0);
    class Custom {
      value = tokenOf("github_token");
    }
    const custom = new Custom();
    const input = {
      yes: true,
      none: null,
      missing: undefined,
      nan: Number.NaN,
      inf: Number.POSITIVE_INFINITY,
      small: 42,
      when,
      custom,
    };
    const result = scrubFrontmatter(input);
    expect(result.data.when).toBe(when);
    expect(result.data.custom).toBe(custom);
    expect(result.data).toEqual(input);
    expect(result.hits.size).toBe(0);
  });

  it("never mutates its input and never changes keys", () => {
    const input = {
      [join("pass", "word")]: join("hunter", "2xyz"),
      list: [tokenOf("aws_access_key_id")],
      nested: { when: new Date(0) },
    };
    const snapshot = structuredClone(input);
    const result = scrubFrontmatter(input);
    expect(input).toEqual(snapshot);
    expect(result.data).not.toBe(input);
    expect(result.data.list).not.toBe(input.list);
    expect(Object.keys(result.data)).toEqual(Object.keys(input));
  });

  it("keeps a __proto__ key as an own property", () => {
    const parsed = JSON.parse(`{"__proto__": {"a": "b"}}`) as Record<string, unknown>;
    const result = scrubFrontmatter(parsed);
    expect(Object.getPrototypeOf(result.data)).toBe(Object.prototype);
    expect(Object.keys(result.data)).toEqual(["__proto__"]);
  });

  it("lets a label key cover every element of an array under it", () => {
    const key = join("to", "ken");
    const result = scrubFrontmatter({
      [key]: [join("hunter", "2xyz"), tokenOf("github_token"), "none", [join("abcdef", "ghij")]],
      other: [join("hunter", "2xyz")],
    });
    expect(result.data[key]).toEqual([
      MARK("labeled_secret"),
      MARK("github_token"),
      "none",
      [MARK("labeled_secret")],
    ]);
    expect(result.data.other).toEqual([join("hunter", "2xyz")]);
    expect(result.hits.get("labeled_secret")).toBe(2);
    expect(result.hits.get("github_token")).toBe(1);
  });

  it("redacts the whole value when something of 6 characters or more remains after the rules", () => {
    const key = join("to", "ken");
    const mixed = `${tokenOf("github_token")} extra12345`;
    const result = scrubFrontmatter({ [key]: mixed });
    expect(result.data[key]).toBe(MARK("labeled_secret"));
    expect([...result.hits]).toEqual([["labeled_secret", 1]]);
  });

  it("redacts a whole labeled value from exactly 6 characters in a run, not from 5", () => {
    const key = join("pass", "word");
    const six = scrubFrontmatter({ [key]: join("abc", "def") });
    expect(six.data[key]).toBe(MARK("labeled_secret"));
    expect([...six.hits]).toEqual([["labeled_secret", 1]]);
    for (const short of [join("abc", "de"), join("ab", " ", "cd"), "a b c", "  abcde  "]) {
      const kept = scrubFrontmatter({ [key]: short });
      expect(kept.data[key]).toBe(short);
      expect(kept.hits.size).toBe(0);
    }
  });

  it("redacts a whole labeled value of 6 or more characters in total even without a 6-run", () => {
    const key = join("pass", "word");
    for (const value of ["red cat 42 ok", "a b c d e f g", join("ab", " ", "cd", " e")]) {
      const result = scrubFrontmatter({ [key]: value });
      expect(result.data[key]).toBe(MARK("labeled_secret"));
      expect([...result.hits]).toEqual([["labeled_secret", 1]]);
    }
  });

  it("applies the 6-run test, not the total length, to a labeled value that already had a hit", () => {
    const key = join("to", "ken");
    const withHit = `a ${tokenOf("github_token")} b c d e`;
    const result = scrubFrontmatter({ [key]: withHit });
    expect(result.data[key]).toBe(`a ${MARK("github_token")} b c d e`);
    expect([...result.hits]).toEqual([["github_token", 1]]);
    const again = scrubFrontmatter(result.data);
    expect(again.data).toEqual(result.data);
    expect(again.hits.size).toBe(0);
  });

  it("is idempotent on a redacted labeled value", () => {
    const key = join("pass", "word");
    const once = scrubFrontmatter({ [key]: "red cat 42 ok" });
    const twice = scrubFrontmatter(once.data);
    expect(twice.data).toEqual(once.data);
    expect(twice.hits.size).toBe(0);
  });

  it("keeps a labeled value that only carries a token the rules already redacted", () => {
    const key = join("to", "ken");
    const result = scrubFrontmatter({ [key]: `see ${tokenOf("github_token")} ok` });
    expect(result.data[key]).toBe(`see ${MARK("github_token")} ok`);
    expect([...result.hits]).toEqual([["github_token", 1]]);
  });

  it("turns a number or bigint that hits a rule into the placeholder string", () => {
    const card = join("4111", "1111", "1111", "1111");
    const result = scrubFrontmatter({ n: Number(card), b: BigInt(card), ok: 7, big: 10n });
    expect(result.data).toEqual({
      n: MARK("card_number"),
      b: MARK("card_number"),
      ok: 7,
      big: 10n,
    });
  });
});

describe("isLabelKey", () => {
  it.each([
    ["pass", "word"],
    ["client", "Secret"],
    ["aws_", "secret_access_key"],
    ["SECRET", "_KEY"],
    ["auth", "Token"],
    ["api", "-key"],
    ["private", "_key"],
    ["credentials", ""],
    ["Sec", "ret Key"],
    ["API", " Key"],
    ["Secret", " Access Key"],
    ["my pass", "word"],
    ["SECRET", "_KEY_BASE"],
    ["DB_PASS", "WORD_PROD"],
    ["DB_PASS", "WORD_US_EAST_1"],
    ["DB_PASS", "WORD_URL_ENCODED"],
    ["API", "_KEY_V2"],
    ["GITHUB_", "TOKEN_RO"],
    ["smtp_pass", "word_2"],
    ["pass", "word1"],
    ["pass", "word1234"],
    ["PASS", "WORD2_PROD"],
    ["pass", "word_a_b_c"],
    ["secret", "KeyBase"],
    ["db", "PasswordProd"],
    ["api", "KeyV2"],
    ["pass", "wordHash"],
    ["API", "Key"],
    ["AWS", "SecretKey"],
    ["x.api", ".key"],
    ["private", "Key"],
    ["access", "Key"],
    ["a", "pikey"],
    ["pw", "d"],
    ["pass", "wd"],
    ["pass", "phrase"],
    ["PG", "PASSWORD"],
    ["AUTH", "TOKEN"],
    ["auth", "token"],
    ["client", "secret"],
    ["secret", "key"],
    ["api", "token"],
    ["access", "token"],
    ["my", "password"],
    ["user", "pwd"],
    ["github", "token"],
    ["x", "token"],
    ["access", "key"],
    ["xAccess", "Key"],
    ["my", "passphrase"],
    ["my", "passwd"],
    ["secret", "accesskey"],
    ["AWS", "SECRETACCESSKEY"],
    ["aws_", "secretaccesskey"],
    ["my", "apikey"],
    ["GOOGLE", "APIKEY"],
    ["OPENAI", "APIKEY"],
    ["my", "secretkey"],
    ["STRIPE", "SECRETKEY"],
    ["aws", "accesskey"],
    ["ssh", "privatekey"],
    ["db", "credentials"],
    ["client", "credentials"],
    ["user", "credential"],
    ["credential", "key"],
    ["token", "key"],
    ["my", "apikey2"],
    ["my", "apikey_prod"],
    ["MYAPI", "_KEY"],
    ["xaccess", "_key"],
    ["xprivate", "_key"],
    ["my", "Api Key"],
    ["pass", "Word"],
    ["Pass", "Word"],
    ["pass", "Phrase"],
    ["Pass", "Phrase"],
    ["pass", "Wd"],
    ["P", "Wd"],
    ["PASS", "Word"],
    ["Key", "PassPhrase"],
    ["ssh", "PassPhrase"],
    ["api", "keykey"],
    ["API_", "KEYKEY_PROD"],
    ["API", "KEYKEY"],
    ["API Key_", "abcdefghijkl"],
    ["the API Key_", "abcdefghijklmnopqrstuvwxyz"],
  ])("accepts %s%s", (a, b) => {
    expect(isLabelKey(join(a as string, b as string))).toBe(true);
  });

  it.each([
    ["secre", "tary"],
    ["to", "ken_count"],
    ["to", "ken_count_2"],
    ["pass", "word_policy"],
    ["api", "_key_name"],
    ["to", "ken_limit"],
    ["secret", "_key_max_size"],
    ["DB_PASS", "WORD_URL"],
    ["max_to", "kens"],
    ["to", "kenizer"],
    ["pass", "wordless"],
    ["access_key", "_id"],
    ["mon", "key"],
    ["key", "board"],
    ["api", ""],
    ["sort_", "key"],
    ["primary ", "key"],
    ["ke", "y"],
    ["ti", "tle"],
    ["", ""],
    ["my", "token_count"],
    ["PG", "PASSWORD_URL"],
    ["auth", "tokens"],
    ["secret", "ary_token_name"],
    ["my", "apikey_name"],
    ["db", "credentials_url"],
    ["x", "privatekey_path"],
    ["therapy", "_key"],
    ["turkey", ""],
    ["donkey", "_id"],
    ["secret", "keyword"],
    ["key", "key"],
    ["mon", "Key"],
    ["sort", "Key"],
    ["pass", "wordCount"],
    ["Pass", "wordUrl"],
    ["Pass", "Phrase_name"],
    ["api", "KeyName"],
    ["pass", "wdCount"],
    ["pass", "word_count2"],
    ["to", "ken_id1"],
    ["secret", "_name2"],
    ["monkey", "key"],
    ["API Key_", "abcdefghijkl_name"],
  ])("rejects %s%s", (a, b) => {
    expect(isLabelKey(join(a as string, b as string))).toBe(false);
  });

  it("reads only the last 4 words and the last 64 characters", () => {
    const word = join("pass", "word");
    expect(isLabelKey(`${word} one two three four`)).toBe(false);
    expect(isLabelKey(`${word} one two three`)).toBe(true);
    expect(isLabelKey(`${word}_${"x".repeat(50)}`)).toBe(true);
    expect(isLabelKey(`${word}_${"x".repeat(70)}`)).toBe(false);
    expect(isLabelKey(`${"x".repeat(100)}_${word}`)).toBe(true);
  });
});

describe("helpers", () => {
  it("luhnValid accepts known valid vectors", () => {
    for (const parts of [
      ["4111", "1111", "1111", "1111"],
      ["5555", "5555", "5555", "4444"],
      ["3782", "8224", "6310", "005"],
      ["4222", "2222", "22222"],
      ["6304", "0000", "0000", "0000", "000"],
    ]) {
      expect(luhnValid(parts.join(""))).toBe(true);
      expect(luhnValid(parts.join(" "))).toBe(true);
      expect(luhnValid(parts.join("-"))).toBe(true);
    }
  });

  it("luhnValid rejects bad checksums, wrong lengths and non-digits", () => {
    for (const parts of [
      ["4111", "1111", "1111", "1113"],
      ["4111", "1111", "1111", "1114"],
      ["4222", "2222", "2222"],
      ["4111", "1111", "1111", "1111", "1111"],
      ["4111", "1111", "1111", "111a"],
      [""],
    ]) {
      expect(luhnValid(parts.join(""))).toBe(false);
    }
  });

  it("ibanValid accepts valid IBANs in any case and with spaces", () => {
    const iban = join("DE89", "3704", "0044", "0532", "0130", "00");
    expect(ibanValid(iban)).toBe(true);
    expect(ibanValid(iban.toLowerCase())).toBe(true);
    expect(ibanValid(join("DE89", " 3704 0044 0532 ", "0130 00"))).toBe(true);
  });

  it("ibanValid rejects a wrong check, length, country, shape and check digits outside 02 to 98", () => {
    expect(ibanValid(join("DE89", "3704", "0044", "0532", "0130", "01"))).toBe(false);
    expect(ibanValid(join("DE89", "3704", "0044", "0532", "0130"))).toBe(false);
    expect(ibanValid(join("ZZ89", "3704", "0044", "0532", "0130", "00"))).toBe(false);
    expect(ibanValid(join("DE", "ab", "3704", "0044", "0532", "0130", "00"))).toBe(false);
    for (const parts of [
      ["DE00", "0000", "0000", "0000", "0000", "66"],
      ["DE01", "0000", "0000", "0000", "0000", "48"],
      ["DE99", "0000", "0000", "0000", "0000", "30"],
    ]) {
      expect(ibanValid(parts.join(""))).toBe(false);
    }
  });

  it("ibanValid enforces the registry country and length even when the checksum is right", () => {
    const withCheck = (country: string, bban: string) => {
      let remainder = 0;
      for (const ch of `${bban}${country}00`) {
        const code = ch.charCodeAt(0);
        remainder =
          code <= 57 ? (remainder * 10 + code - 48) % 97 : (remainder * 100 + code - 55) % 97;
      }
      return `${country}${String(98 - remainder).padStart(2, "0")}${bban}`;
    };
    const bban = join("37", "0400440532013000");
    expect(ibanValid(withCheck("DE", bban))).toBe(true);
    expect(ibanValid(withCheck("DE", `${bban}0`))).toBe(false);
    expect(ibanValid(withCheck("DE", bban.slice(1)))).toBe(false);
    expect(ibanValid(withCheck("ZZ", bban))).toBe(false);
    expect(ibanValid(withCheck("NL", "ABNA0417164300"))).toBe(true);
  });

  it("isPlaceholder accepts only exact placeholder shapes", () => {
    for (const value of [
      join("${DB_", "PASSWORD}"),
      join("${{ secrets.", "NAME }}"),
      join("$DB_", "PASSWORD"),
      join("<your-api-", "key>"),
      "{{ vault_value }}",
      "%s",
      "%d",
    ]) {
      expect(isPlaceholder(value)).toBe(true);
    }
    for (const value of [
      join("hunter", "2xyz"),
      join("$up", "erSecret9"),
      join("${DB_", "PASSWORD}x"),
      join("x<your-api-", "key>"),
      "<unclosed",
      "",
    ]) {
      expect(isPlaceholder(value)).toBe(false);
    }
  });
});

describe("IBAN country table", () => {
  it("has the 89 countries as transcribed from the public registry, with sane lengths", () => {
    const countries = Object.keys(IBAN_LENGTHS);
    expect(countries).toHaveLength(89);
    for (const country of countries) {
      expect(country).toMatch(/^[A-Z]{2}$/);
      const length = IBAN_LENGTHS[country] as number;
      expect(length).toBeGreaterThanOrEqual(15);
      expect(length).toBeLessThanOrEqual(34);
    }
    expect(IBAN_LENGTHS.DE).toBe(22);
    expect(IBAN_LENGTHS.FR).toBe(27);
    expect(IBAN_LENGTHS.GB).toBe(22);
  });

  it("has one registry example per country", () => {
    expect(Object.keys(ibanExamples).sort()).toEqual(Object.keys(IBAN_LENGTHS).sort());
  });

  it.each(Object.entries(ibanExamples))(
    "the %s example is valid and scrubbed",
    (country, parts) => {
      const iban = parts.join("");
      expect(iban.startsWith(country)).toBe(true);
      expect(iban).toHaveLength(IBAN_LENGTHS[country] as number);
      expect(ibanValid(iban)).toBe(true);
      for (const written of [iban, parts.join(" ")]) {
        const result = scrub(`pay ${written} now`);
        expect(result.text).toBe(`pay ${MARK("iban")} now`);
        expect([...result.hits]).toEqual([["iban", 1]]);
      }
    },
  );
});

describe("failures surface as ScrubError (D3, D7)", () => {
  const input = `see ${tokenOf("github_token")} and ${join("4111", "1111", "1111", "1111")}`;

  function failing(rule: ScrubRule, text = "abc") {
    let caught: unknown;
    try {
      scrub(text, [rule]);
    } catch (error) {
      caught = error;
    }
    return caught;
  }

  it("wraps a throwing select, naming only the rule id", () => {
    const rule: ScrubRule = {
      id: "boom",
      pattern: /[a-z]+/g,
      select() {
        throw new Error(`leaky detail ${input}`);
      },
    };
    const error = failing(rule, input);
    expect(error).toBeInstanceOf(ScrubError);
    expect((error as ScrubError).rule).toBe("boom");
    expect((error as ScrubError).message).toBe("Scrub rule boom failed");
    expect((error as ScrubError).cause).toBeUndefined();
    expect((error as ScrubError).name).toBe("ScrubError");
  });

  it("rejects a pattern without the g flag", () => {
    const error = failing({ id: "nog", pattern: /abc/ });
    expect(error).toBeInstanceOf(ScrubError);
    expect((error as ScrubError).message).toBe("Scrub rule nog failed");
  });

  it("rejects a secret group without keep, and keep plus secret that is not the match", () => {
    expect(failing({ id: "nokeep", pattern: /(?<secret>abc)/g })).toBeInstanceOf(ScrubError);
    expect(failing({ id: "onlykeep", pattern: /(?<keep>a)bc/g })).toBeInstanceOf(ScrubError);
    expect(failing({ id: "gap", pattern: /(?<keep>a)b(?<secret>c)/g })).toBeInstanceOf(ScrubError);
  });

  it("does not echo a rule id that is not well formed", () => {
    const error = failing({ id: input, pattern: /abc/g });
    expect(error).toBeInstanceOf(ScrubError);
    expect((error as ScrubError).message).toBe("Scrub rule unknown failed");
  });

  it("is raised by scrubFrontmatter too", () => {
    const rule: ScrubRule = {
      id: "boom",
      pattern: /a/g,
      select() {
        throw new Error("x");
      },
    };
    expect(() => scrubFrontmatter({ a: "a" }, [rule])).toThrow(ScrubError);
  });

  it.each([
    ["zero length", { start: 1, end: 1 }],
    ["backwards", { start: 2, end: 1 }],
    ["past the end", { start: 0, end: 99 }],
    ["negative start", { start: -1, end: 2 }],
    ["fractional", { start: 0.5, end: 2 }],
  ])("throws when select returns a span that is %s", (_name, span) => {
    const rule: ScrubRule = { id: "span", pattern: /[a-z]+/g, select: () => span };
    expect(failing(rule, "abcd")).toBeInstanceOf(ScrubError);
  });

  it("throws when a later span starts before the offset it was asked from", () => {
    const rule: ScrubRule = {
      id: "back",
      pattern: /[a-z]+/g,
      select: (_found, from) => (from === 0 ? { start: 0, end: 2 } : { start: 1, end: 3 }),
    };
    expect(failing(rule, "abcd")).toBeInstanceOf(ScrubError);
  });

  it("counts one hit per span and keeps the text between spans", () => {
    const rule: ScrubRule = {
      id: "pair",
      pattern: /[a-z]+/g,
      select(found, from) {
        const at = found.indexOf("ab", from);
        return at < 0 ? null : { start: at, end: at + 2 };
      },
    };
    const result = scrub("abxab 12 abab", [rule]);
    expect(result.text).toBe(`${MARK("pair")}x${MARK("pair")} 12 ${MARK("pair")}${MARK("pair")}`);
    expect(result.hits.get("pair")).toBe(4);
  });

  it("hands the named groups of the match to select, and an empty object when there are none", () => {
    const seen: Array<Record<string, string | undefined>> = [];
    const record: ScrubRule["select"] = (_found, _from, groups) => {
      seen.push({ ...groups });
      return null;
    };
    scrub("k=abc", [{ id: "named", pattern: /(?<keep>k=)(?<secret>[a-z]+)/g, select: record }]);
    scrub("abc", [{ id: "plain", pattern: /[a-z]+/g, select: record }]);
    expect(seen).toEqual([{ keep: "k=", secret: "abc" }, {}]);
  });

  describe("head and tail rules", () => {
    const heads = (admitted: string[], tail = /[0-9]+/y) =>
      ({
        id: "headed",
        pattern: /(?<keep>(?<label>[a-z]+)=)/g,
        tail,
        admit: (groups) => {
          admitted.push(groups.label ?? "");
          return groups.label !== "no";
        },
        select: (_found, from) => (from === 0 ? { start: 0, end: 2 } : null),
      }) satisfies ScrubRule;

    it("resumes right after a rejected head, so a head inside the rejected value is examined", () => {
      const admitted: string[] = [];
      // The tail would swallow "ok=123" if it were read for the rejected head.
      const result = scrub("no=ok=123 and no=77", [heads(admitted, /[a-z0-9=]+/y)]);
      // "no=" is rejected; the scan resumes at "ok=", which is admitted and takes "123".
      expect(result.text).toBe(`no=ok=${MARK("headed")}3 and no=77`);
      expect(admitted).toEqual(["no", "ok", "no"]);
      expect(result.hits.get("headed")).toBe(1);
    });

    it("resumes right after a head without a tail match, and after an admitted tail", () => {
      const result = scrub("a=b=12 c=345 d=", [heads([])]);
      // "a=" has no tail (b is not a digit), "b=" takes "12", "c=" takes "345", "d=" has none.
      expect(result.text).toBe(`a=b=${MARK("headed")} c=${MARK("headed")}5 d=`);
      expect(result.hits.get("headed")).toBe(2);
    });

    it("hands select the head groups plus the tail as secret, and the span is read against the tail", () => {
      const seen: Array<Record<string, string | undefined>> = [];
      const rule: ScrubRule = {
        id: "seen",
        pattern: /(?<keep>(?<label>[a-z]+)=)/g,
        tail: /[0-9]+/y,
        select: (_found, _from, groups) => {
          seen.push({ ...groups });
          return null;
        },
      };
      expect(scrub("k=42", [rule]).text).toBe("k=42");
      expect(seen).toEqual([{ keep: "k=", label: "k", secret: "42" }]);
    });

    it("keeps working when the replaced head is followed by more text, and without admit", () => {
      const rule: ScrubRule = { id: "plain", pattern: /(?<keep>k=)/g, tail: /\d+/y };
      const result = scrub("k=12 k=x k=3", [rule]);
      expect(result.text).toBe(`k=${MARK("plain")} k=x k=${MARK("plain")}`);
      expect(result.hits.get("plain")).toBe(2);
    });

    it("throws when the tail is not sticky, or the head is not exactly the keep group", () => {
      const sticky = failing({ id: "nosticky", pattern: /(?<keep>k=)/g, tail: /\d+/g }, "k=1");
      expect(sticky).toBeInstanceOf(ScrubError);
      const partial = failing({ id: "partial", pattern: /(?<keep>k)=/g, tail: /\d+/y }, "k=1");
      expect(partial).toBeInstanceOf(ScrubError);
      const both = failing(
        { id: "both", pattern: /(?<keep>k=)(?<secret>1)/g, tail: /\d+/y },
        "k=12",
      );
      expect(both).toBeInstanceOf(ScrubError);
      const bare = failing({ id: "bare", pattern: /k=/g, tail: /\d+/y }, "k=1");
      expect(bare).toBeInstanceOf(ScrubError);
    });

    it("wraps a throwing admit, naming only the rule id", () => {
      const rule: ScrubRule = {
        id: "admitboom",
        pattern: /(?<keep>k=)/g,
        tail: /\d+/y,
        admit() {
          throw new Error(`leaky ${input}`);
        },
      };
      const error = failing(rule, "k=1");
      expect(error).toBeInstanceOf(ScrubError);
      expect((error as ScrubError).message).toBe("Scrub rule admitboom failed");
    });
  });

  it("leaves a match alone when select finds nothing", () => {
    const rule: ScrubRule = { id: "none", pattern: /[a-z]+/g, select: () => null };
    const result = scrub("abc", [rule]);
    expect(result.text).toBe("abc");
    expect(result.hits.size).toBe(0);
  });
});

describe("the scrubber's own files carry no secrets (D4)", () => {
  const files = [
    new URL("positive.json", FIXTURE_DIR),
    new URL("negative.json", FIXTURE_DIR),
    new URL("iban-examples.json", FIXTURE_DIR),
    new URL("scrub.test.ts", import.meta.url),
    ...readdirSync(new URL("../src/vault/scrub/", import.meta.url))
      .filter((name) => name.endsWith(".ts"))
      .map((name) => new URL(`../src/vault/scrub/${name}`, import.meta.url)),
  ];

  it("finds the files it is supposed to read", () => {
    expect(files.map((file) => file.pathname.split("/").pop()).sort()).toEqual(
      [
        "index.ts",
        "iban-examples.json",
        "negative.json",
        "positive.json",
        "rules.ts",
        "scrub.test.ts",
      ].sort(),
    );
  });

  it.each(files.map((file) => [file.pathname.split("/").pop() as string, file] as const))(
    "scrubbing the raw text of %s gives empty hits",
    (_name, file) => {
      const result = scrub(readFileSync(file, "utf8"));
      expect([...result.hits]).toEqual([]);
    },
  );
});

describe("adversarial 1 MiB inputs finish in under 5000 ms (D5)", () => {
  const SIZE = 1024 * 1024;
  const repeat = (unit: string) => unit.repeat(Math.ceil(SIZE / unit.length)).slice(0, SIZE);
  const label = join("pass", "word=");
  const card = ["4111", "1111", "1111", "1111"].join(" ");
  const iban = ["DE89", "3704", "0044", "0532", "0130", "00"].join(" ");
  const inputs: Array<[string, string]> = [
    ["spaces", repeat(" ")],
    ["digits", repeat("7")],
    ["zero digits", repeat("0")],
    ["mixed digits", repeat("1234567890")],
    ["1 runs", repeat("1 ")],
    ["label runs", repeat(label)],
    ["label words joined by spaces", repeat("secret access key ")],
    ["api key words", repeat("api key ")],
    ["label tails", repeat(join("pass", "word_ab_cd_"))],
    ["label tail digits", repeat(join("pass", "word123"))],
    ["camelCase identifiers", repeat("clientSecretValueXyz")],
    ["camelCase pairs", repeat("aB")],
    ["camelCase words joined by spaces", repeat("clientSecret ")],
    ["15 character words joined by spaces", repeat("aaaaaaaaaaaaaaa ")],
    ["dotted identifier", repeat("a.b-c_")],
    ["labels that name something else", repeat("a=bbbbbb ")],
    ["compound key labels", repeat(join("AWS", "SECRETACCESS", "KEY", "=bbbbbb "))],
    ["compound key labels that name something else", repeat("myapikey_name=bbbbbb&")],
    ["credentials labels", repeat("dbcredentials_url=bbbbbb;")],
    ["words ending in api before key", repeat("xapi_key_xaccess_key_")],
    [
      "spaced words with a 64 character last word",
      repeat(`aaaaaaaaaaaaaaa aaaaaaaaaaaaaaa aaaaaaaaaaaaaaa ${"a".repeat(64)} `),
    ],
    ["spaced words with a 64 character last word and =", repeat(`a b c ${"x".repeat(64)}=bbbbbb `)],
    ["spaced words with a long API Key last word", repeat(`API Key_${"a".repeat(56)}=bbbbbb `)],
    ["spaced words, 64 character last word, no separator", repeat(`aa bb cc ${"d".repeat(64)}`)],
    [
      "spaced words with a 64 character last word and a short value",
      repeat(`${"a".repeat(15)} ${"a".repeat(15)} ${"a".repeat(15)} ${"x".repeat(63)}=bbb `),
    ],
    ["hump inside core words", repeat("passWordPassPhrasePWd")],
    ["keykey runs", repeat("apikeykeykeykey_keykey ")],
    ["64 character compound labels", repeat(`${"a".repeat(50)}secretaccesskey_`)],
    ["token_count runs", repeat("token_count=")],
    ["token_count runs with values", repeat("token_count=bbbbbb ")],
    ["rejected assignments", repeat("a=b&")],
    ["rejected assignments with values", repeat("a=bbbbbb&")],
    ["rejected assignments in a quoted value", `x="${repeat("a=bbbbbb&")}`],
    ["rejected assignments after url=", `url=${repeat("k=abcdef&")}`],
    ["minified JSON keys", `{${repeat('"a":"bbbbbb",')}`],
    ["rejected options", repeat("--o=abcdef ")],
    ["a value holding token_count runs", `x=${repeat("token_count=bbbbbb&")}`],
    ["a quoted value holding labels", `x="${repeat(join("a=bbbbbb pass", "word=cccccc "))}"`],
    ["short closed single quotes", repeat(join("pass", "word='ab'"))],
    ["short closed double quotes", repeat(join("pass", 'word="ab"'))],
    ["short closed then more", repeat(join("pass", "word='ab'cdefg"))],
    ["escaped short values", repeat(join("pass", 'word=\\"ab\\"'))],
    ["double-encoded JSON", repeat(join('{\\"pass', 'word\\":\\"ab\\"}'))],
    ["escaped open quote then lines", `${join("pass", 'word=\\"')}${repeat("ab cd\n")}`],
    ["3-3-3-3-4 digit groups", repeat("123 456 789 012 3456 ")],
    ["4-6-5 digit groups", repeat("1234 567890 12345 ")],
    ["escaped quotes after an open quote", `${join("pass", 'word="')}${repeat('\\"a')}`],
    ["closed quoted value", `${join("pass", 'word="')}${repeat("a1b2")}"`],
    ["digits grouped by spaces", repeat("1234 ")],
    ["digits grouped by hyphens", repeat("12-")],
    ["open quote then a", `${join("pass", 'word="')}${repeat("a")}`],
    ["open quote then lines", `${join("pass", 'word="')}${repeat("ab cd\n")}`],
    ["unquoted label then a", `${label}${repeat("a")}`],
    ["unquoted label then punctuation", `${label}${repeat("ab;c")}`],
    ["a run then =x", `${repeat("a")}=x`],
    ["Bearer runs", repeat("Bearer ")],
    ["Bearer then a", `Bearer ${repeat("a")}`],
    ["eyJ runs", repeat("eyJ")],
    ["eyJ then a run", `eyJ${repeat("a")}`],
    ["eyJ with dots", repeat(`eyJ${"a".repeat(8)}.`)],
    ["base64url run", repeat("Ab1-_")],
    ["BEGIN runs", repeat(join("-----BEGIN", " "))],
    ["BEGIN lines", repeat(join("-----BEGIN ", "PRIVATE KEY-----\n"))],
    [
      "BEGIN lines with END",
      repeat(join("-----BEGIN ", "PRIVATE KEY-----\n", "-----END ", "PRIVATE KEY-----\n")),
    ],
    ["AAAA runs", repeat(join("DE89", " AAAA "))],
    ["card runs", repeat(`${card} `)],
    ["IBAN runs", repeat(`${iban} `)],
    ["IBAN compact runs", repeat(iban.replace(/ /g, ""))],
    ["sk- run", `sk-${repeat("a")}`],
    ["gh_ run", `gh${"p_"}${repeat("a")}`],
  ];

  it.each(inputs)("%s", (_name, input) => {
    const started = performance.now();
    const result = scrub(input);
    const elapsed = performance.now() - started;
    expect(result.text.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(5000);
  });
});
