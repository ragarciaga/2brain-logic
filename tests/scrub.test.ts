import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  IBAN_LENGTHS,
  ibanValid,
  isPlaceholder,
  LABEL_KEY,
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

/** Independent brute force for the card rule: every Luhn-valid window of 13 to 19 digits. */
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
    const merged: Array<[number, number]> = [];
    for (let start = 0; start < digits.length; start++) {
      let end = -1;
      for (let len = 13; len <= 19 && start + len <= digits.length; len++) {
        if (luhn(digits.slice(start, start + len))) end = start + len;
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

  it("matches a brute-force oracle on seeded random digit runs", () => {
    let state = 20241031;
    const next = (limit: number) => {
      // mulberry32
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return (((t ^ (t >>> 14)) >>> 0) % limit) | 0;
    };
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
      redacted += expected.count;
    }
    expect(redacted).toBeGreaterThan(50);
  });

  it("starts the next span at a window that begins exactly where the previous one ends", () => {
    // 27 contiguous digits: the first span is [0,14) and no Luhn-valid window starts inside it,
    // so the second span starts at offset 14, exactly where the first one ends.
    const input = join("4262", "2844", "4493", "4771", "3228", "6329", "523");
    expect(cardOracle(input).count).toBe(2);
    const result = scrub(input, [cardRule]);
    expect(result.text).toBe(`${MARK("card_number")}${MARK("card_number")}`);
    expect(result.hits.get("card_number")).toBe(2);
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

  it("keeps the quotes around a redacted quoted value", () => {
    const input = `${join("pass", "word")}: "${join("hunter", "2xyz")}" and more`;
    expect(scrub(input).text).toBe(`${join("pass", "word")}: "${MARK("labeled_secret")}" and more`);
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
    for (const short of [join("abc", "de"), join("ab", " ", "cd", " e"), "a b c d e f g"]) {
      const kept = scrubFrontmatter({ [key]: short });
      expect(kept.data[key]).toBe(short);
      expect(kept.hits.size).toBe(0);
    }
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

describe("LABEL_KEY", () => {
  it.each([
    ["pass", "word"],
    ["client", "Secret"],
    ["aws_", "secret_access_key"],
    ["SECRET", "_KEY"],
    ["auth", "Token"],
    ["api", "-key"],
    ["private", "_key"],
    ["credentials", ""],
  ])("accepts %s%s", (a, b) => {
    expect(LABEL_KEY.test(join(a as string, b as string))).toBe(true);
  });

  it.each([
    ["secre", "tary"],
    ["to", "ken_count"],
    ["ti", "tle"],
    ["my pass", "word"],
    ["", ""],
  ])("rejects %s%s", (a, b) => {
    expect(LABEL_KEY.test(join(a as string, b as string))).toBe(false);
  });

  it("is not a stateful global regex", () => {
    expect(LABEL_KEY.global).toBe(false);
    expect(LABEL_KEY.sticky).toBe(false);
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
