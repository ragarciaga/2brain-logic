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
const PW = P("hun", "ter", "2x");
const B64 = P("dXNlcjpw", "YXNz", "d29yZA==");
const Q = String.raw`\"`;
const PRIV_ESC = P(PRIV, String.raw`\n`, "MIIBxx", String.raw`\n`, PRIV_END);

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
  [
    "escaped json private key",
    `{"cert":"-----END CERTIFICATE-----\\n${PRIV_ESC}"}`,
    `{"cert":"-----END CERTIFICATE-----\\n${R}"}`,
    1,
  ],
  ["private key glued to a word", `cert.pem${PRIV}\nAA\n${PRIV_END}`, `cert.pem${R}`, 1],
  ["escaped assignment value", `API_KEY=${Q}${PW}${Q}`, `API_KEY=${Q}${R}${Q}`, 1],
  [
    "escaped json pair",
    `{${Q}client_secret${Q}:${Q}${PW}${Q}}`,
    `{${Q}client_secret${Q}:${Q}${R}${Q}}`,
    1,
  ],
  [
    "url userinfo without a user",
    `redis://:${PW}@cache.example.com:6379`,
    `redis://:${R}@cache.example.com:6379`,
    1,
  ],
  ["quoted json cookie", `{"cookie": "sid=${PW}"}`, `{"cookie": "${R}"}`, 1],
  ["quoted json Cookie key", `{"Cookie": "session=${PW}"}`, `{"Cookie": "${R}"}`, 1],
  ["single-quoted cookie", `Cookie: 'sid=${PW}'`, `Cookie: '${R}'`, 1],
  [
    "url userinfo",
    `psql postgres://app:${PW}@db.example.com/main`,
    `psql postgres://app:${R}@db.example.com/main`,
    1,
  ],
  ["basic auth", `Authorization: Basic ${B64}`, `Authorization: Basic ${R}`, 1],
  [
    "curl -u",
    `curl -u admin:${PW} https://api.example.com`,
    `curl -u admin:${R} https://api.example.com`,
    1,
  ],
  [
    "curl --user",
    `curl --user admin:${PW} https://api.example.com`,
    `curl --user admin:${R} https://api.example.com`,
    1,
  ],
  ["cookie header", `Cookie: sid=${PW}; theme=dark`, `Cookie: ${R}`, 1],
  ["set-cookie header", `Set-Cookie: sid=${PW}; Path=/`, `Set-Cookie: ${R}`, 1],
  ["DB_PASS", `DB_PASS=${PW}`, `DB_PASS=${R}`, 1],
  ["MYSQL_PWD", `MYSQL_PWD=${PW}`, `MYSQL_PWD=${R}`, 1],
  ["passwd", `passwd: ${PW}`, `passwd: ${R}`, 1],
  ["credential", `AWS_CREDENTIAL=${PW}`, `AWS_CREDENTIAL=${R}`, 1],
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
  ["comparison", "if (keys.length === 0) return"],
  ["equality", "if (token == other) go()"],
  ["tokens var", "const tokens = text.split(' ')"],
  ["maxTokens", "maxTokens: 4096"],
  ["token_count", "token_count=1234"],
  ["tokenId", "tokenId=7"],
  ["primary_key", "primary_key: id"],
  ["sortKey", "sortKey: name"],
  ["hotkey", "hotkey: ctrl+k"],
  ["key-file", "--key-file ./id.pem"],
  ["keys count", "keys: 3 files"],
  ["basic prose", "Basic authentication is documented"],
  ["basic short", "Basic setup"],
  ["cookie prose", "the cookie jar is empty"],
  ["url no password", "git clone https://user@host.example.com/repo"],
  ["url no userinfo", "see https://example.com/a:b@c"],
  ["curl -u no colon", "git push -u origin main"],
  ["already redacted url", "postgres://app:[redacted]@db.example.com/x"],
  ["PWD", "PWD=/home/user/work"],
  ["OLDPWD", "OLDPWD: /home/user"],
  ["uid:gid with -u", "docker run -u 1000:1000 image"],
  ["uid:gid with --user", "docker run --user 1000:100 image"],
  ["bearer in prose", "the Bearer scheme is documented"],
];

/** Rows that redact once, with the unterminated key block last (it runs to the end of the text). */
function ordered(): [string, string, string, number][] {
  const mark = (r: [string, string, string, number]): number =>
    Number(r[0].includes("without END"));
  return positive.filter((r) => r[3] === 1).sort((a, b) => mark(a) - mark(b));
}

describe("preScrub", () => {
  it.each(positive)("%s", (_n, input, expected, count) => {
    expect(preScrub(input)).toStrictEqual({ text: expected, count });
  });

  it("sums the counts of a text holding every shape", () => {
    const rows = ordered();
    const input = rows.map((r) => r[1]).join("\n");
    const out = preScrub(input);
    expect(out.count).toBe(rows.length);
    expect(out.text).toBe(rows.map((r) => r[2]).join("\n"));
  });

  it("is idempotent and the fixture reaches every rule", () => {
    const rows = ordered();
    const input = rows.map((r) => r[1]).join("\n");
    const first = preScrub(input);
    expect(first.count).toBe(rows.length);
    expect(preScrub(first.text)).toStrictEqual({ text: first.text, count: 0 });
  });

  it.each(negative)("leaves %s unchanged", (_n, input) => {
    expect(preScrub(input)).toStrictEqual({ text: input, count: 0 });
  });

  it.each([
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
  ])("keeps the value when the name ends in %s", (word) => {
    const input = `my_token_${word}: 5`;
    expect(preScrub(input)).toStrictEqual({ text: input, count: 0 });
    expect(preScrub("my_token: 5").count).toBe(1);
  });

  it("finishes hostile inputs under 500 ms", () => {
    const inputs = [
      `${PRIV}\n${"A".repeat(199000)}`,
      "KEY=".repeat(50000),
      "-----BEGIN ".repeat(18000),
      "a.".repeat(100000),
      "Bearer ".repeat(28000),
      `${"K".repeat(100)}${" ".repeat(100000)}:`,
      "http://u:".repeat(25000),
      `http://${"u".repeat(150000)}`,
      "Basic ".repeat(30000),
      `Basic ${"a".repeat(199000)}`,
      "-u a:".repeat(40000),
      "--user ".repeat(28000),
      "cookie:".repeat(28000),
      "Set-Cookie: ".repeat(16000),
      `${Q}${Q}`.repeat(50000),
      'KEY=\\"'.repeat(40000),
      `KEY=\\"${"a ".repeat(90000)}`,
      "PASS.".repeat(40000),
      "redis://:".repeat(25000),
      `redis://${":".repeat(150000)}`,
      'cookie"'.repeat(30000),
      `cookie: '${"'".repeat(150000)}`,
      "-u 1:".repeat(40000),
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
