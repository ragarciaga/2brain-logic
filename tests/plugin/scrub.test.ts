import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { preScrub, RULES } from "../../plugin/scripts/lib/scrub.mjs";
import { scanImports, scanNetwork, scanOwnerData } from "./helpers/plugin-scan.js";

/** Secret shapes are built from parts so no literal ever sits in the tree. */
const P = (...p: string[]): string => p.join("");
const R = "[redacted]";

const PRIV = P("-----BEG", "IN RSA PRIV", "ATE KEY-----");
const PRIV_END = P("-----E", "ND RSA PRIV", "ATE KEY-----");
const ANT = P("sk-", "ant-", "a1B2c3D4e5F6g7H8i9J0");
const GHP = P("gh", "p_", "a".repeat(36));
const PAT = P("github", "_pat_", "A1b2C3d4E5f6G7h8I9j0K1");
const SLACK = P("xo", "xb-", "1234567890-abcd");
const AWS = P("AK", "IA", "ABCDEFGHIJKLMNOP");
const BEARER_TOKEN = P("abcdefgh", "12345678", "ABCDEFGH");

const positive: [string, string, string, number][] = [
  ["private key block", `a\n${PRIV}\nMIIBxx\n${PRIV_END}\nb`, `a\n${R}\nb`, 1],
  ["private key without END", `a\n${PRIV}\nMIIBxx\nmore`, `a\n${R}`, 1],
  ["bearer", `Authorization: Bearer ${BEARER_TOKEN}`, `Authorization: Bearer ${R}`, 1],
  ["bearer with padding", `Bearer ${BEARER_TOKEN}==`, `Bearer ${R}`, 1],
  ["API_KEY", "API_KEY=v", `API_KEY=${R}`, 1],
  ["export token", "export GITHUB_TOKEN=v", `export GITHUB_TOKEN=${R}`, 1],
  ["lowercase password", "db_password: v", `db_password: ${R}`, 1],
  ["quoted secret", 'MY_SECRET="v w"', `MY_SECRET="${R}"`, 1],
  ["json key", '{"apiKey": "v"}', `{"apiKey": "${R}"}`, 1],
  ["flag form", "--password v", `--password ${R}`, 1],
  ["already redacted quoted", `MY_SECRET="${R}"`, `MY_SECRET="${R}"`, 0],
  ["anthropic", `x ${ANT} y`, `x ${R} y`, 1],
  ["github token", `x ${GHP} y`, `x ${R} y`, 1],
  ["github pat", `x ${PAT} y`, `x ${R} y`, 1],
  ["slack", `x ${SLACK} y`, `x ${R} y`, 1],
  ["aws", `x ${AWS} y`, `x ${R} y`, 1],
  ["assignment of a prefixed token counts once", `API_KEY=${ANT}`, `API_KEY=${R}`, 1],
];

const negative: [string, string][] = [
  ["prose", "We shipped the feature and wrote the notes today."],
  ["keyboard layout", "keyboard layout: qwerty"],
  ["git sha", "commit 0123456789abcdef0123456789abcdef01234567 landed"],
  ["uuid", "id 123e4567-e89b-12d3-a456-426614174000 here"],
  ["bare AKIA", "AKIA"],
  ["AKIA body one character too long", `${AWS}Q`],
  ["short bearer token", "Bearer abcdefgh1234567"],
  ["bare ghp_", "ghp_"],
  ["bare sk-ant", "sk-ant"],
  ["bearer in prose", "the Bearer scheme is documented"],
];

describe("preScrub", () => {
  it.each(positive)("%s", (_n, input, expected, count) => {
    expect(preScrub(input)).toStrictEqual({ text: expected, count });
  });

  it("sums the counts of a text holding every shape", () => {
    // An unterminated key block runs to the end of the text, so it goes last.
    const rows = positive
      .filter((r) => r[3] === 1)
      .sort((a, b) => Number(a[0].includes("without END")) - Number(b[0].includes("without END")));
    const input = rows.map((r) => r[1]).join("\n");
    const out = preScrub(input);
    expect(out.count).toBe(rows.length);
    expect(out.text).toBe(rows.map((r) => r[2]).join("\n"));
  });

  it("is idempotent", () => {
    const input = positive.map((r) => r[1]).join("\n");
    expect(preScrub(input).count).toBeGreaterThan(0);
    const first = preScrub(input);
    expect(preScrub(first.text)).toStrictEqual({ text: first.text, count: 0 });
  });

  it.each(negative)("leaves %s unchanged", (_n, input) => {
    expect(preScrub(input)).toStrictEqual({ text: input, count: 0 });
  });

  it("finishes hostile inputs under 500 ms", () => {
    const inputs = [
      `${PRIV}\n${"A".repeat(199000)}`,
      "KEY=".repeat(50000),
      "-----BEGIN ".repeat(18000),
      "a.".repeat(100000),
      "Bearer ".repeat(28000),
      `${"K".repeat(100)}${" ".repeat(100000)}:`,
    ];
    for (const input of inputs) {
      const t0 = performance.now();
      preScrub(input);
      expect(performance.now() - t0).toBeLessThan(500);
    }
  });

  it("keeps a fixed frozen rule list", () => {
    expect(Object.isFrozen(RULES)).toBe(true);
  });

  it("passes the plugin scans", () => {
    const src = readFileSync(
      join(import.meta.dirname, "..", "..", "plugin", "scripts", "lib", "scrub.mjs"),
      "utf8",
    );
    expect(scanImports(src)).toStrictEqual([]);
    expect(scanNetwork(src)).toStrictEqual([]);
    expect(scanOwnerData(src)).toStrictEqual([]);
  });
});
