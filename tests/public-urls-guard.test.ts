import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");
const DIRECTORIES = ["src/mcp", "src/auth"];
const EXTENSIONS = [".ts", ".mts", ".cts", ".tsx"];

/**
 * The one exemption: the rate limiter may read the client address header, nothing else.
 * Matched on the file path (with `/`) and on the text of the quoted name.
 */
const ALLOWLIST = [{ file: "src/auth/rate-limit.ts", quoted: /^["'`]x-forwarded-for["'`]$/i }];

interface Rule {
  name: string;
  pattern: RegExp;
}

/** Whitespace-tolerant, so a request object split over lines is still found. */
const RULES: Rule[] = [
  {
    name: "req.url / req.raw / req.headers",
    pattern: /\breq\s*(?:\?\.|\.)\s*(?:raw|url|headers)\b/g,
  },
  {
    name: "destructured url / raw / headers from a request",
    pattern: /\{[^}]*\b(?:url|raw|headers)\b[^}]*\}\s*=\s*[\w.$]*\breq\b/g,
  },
  { name: "bracket access on a request", pattern: /\breq\s*\??\.?\s*\[/g },
  { name: "header() without an argument", pattern: /\.header\(\s*\)/g },
  {
    name: "quoted host or forwarded header name",
    pattern: /(["'`])(?:host|forwarded|x-forwarded-[\w-]*)\1/gi,
  },
];

interface Finding {
  file: string;
  line: number;
  rule: string;
}

function findForbidden(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  for (const rule of RULES) {
    for (const match of text.matchAll(rule.pattern)) {
      const allowed = ALLOWLIST.some((entry) => entry.file === file && entry.quoted.test(match[0]));
      if (allowed) continue;
      const line = text.slice(0, match.index).split("\n").length;
      findings.push({ file, line, rule: rule.name });
    }
  }
  return findings;
}

function listFiles(): string[] {
  const files: string[] = [];
  for (const directory of DIRECTORIES) {
    const entries = readdirSync(join(ROOT, directory), { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!EXTENSIONS.some((extension) => entry.name.endsWith(extension))) continue;
      const path = relative(ROOT, join(entry.parentPath, entry.name));
      files.push(path.split(sep).join("/"));
    }
  }
  return files.sort();
}

describe("D2: the public app builds no URL from the request", () => {
  it("scans the public app files, including app.ts, metadata.ts and ingest-token.ts", () => {
    const files = listFiles();
    expect(files).toContain("src/mcp/app.ts");
    expect(files).toContain("src/auth/oauth/metadata.ts");
    expect(files).toContain("src/auth/ingest-token.ts");
  });

  it("finds no forbidden request access under src/mcp and src/auth", () => {
    const findings = listFiles().flatMap((file) =>
      findForbidden(file, readFileSync(join(ROOT, file), "utf8")),
    );
    const report = findings.map((f) => `${f.file}:${f.line} ${f.rule}`);
    // A new directory with public-app code must be added to DIRECTORIES.
    expect(
      report,
      "all public-app code lives under src/mcp and src/auth, and advertised URLs come from c.var.urls only",
    ).toEqual([]);
  });
});

describe("D2: the guard patterns", () => {
  const forbidden = [
    "const a = c.req.url;",
    "const a = c.req.raw.url;",
    "const a = c.req.raw.headers.get('x');",
    "const a = req.raw;",
    "const a = ctx.req?.url;",
    "const a = c.req\n  .url;",
    "const { url } = c.req;",
    "const { raw } = context.req;",
    "const a = c.req['url'];",
    "const a = c.req.header();",
    'const h = "host";',
    "const h = 'Host';",
    "const h = `HOST`;",
    'c.req.header("x-forwarded-host")',
    'const h = "X-Forwarded-Proto";',
    'const h = "x-forwarded-for";',
    'const h = "forwarded";',
  ];
  for (const sample of forbidden) {
    it(`flags ${JSON.stringify(sample)}`, () => {
      expect(findForbidden("src/mcp/x.ts", sample).length).toBeGreaterThan(0);
    });
  }

  const allowed = [
    'const a = c.req.header("authorization");',
    "const a = c.req.path;",
    "const a = c.req.method;",
    "const a = c.var.urls.issuer;",
    'c.header("Cache-Control", "no-store");',
    'const a = "localhost";',
    'const a = "hostname-check";',
    "const { issuer } = c.var.urls;",
    "const { name } = request;",
  ];
  for (const sample of allowed) {
    it(`accepts ${JSON.stringify(sample)}`, () => {
      expect(findForbidden("src/mcp/x.ts", sample)).toEqual([]);
    });
  }

  it("exempts only x-forwarded-for, and only in src/auth/rate-limit.ts", () => {
    const sample = 'const a = c.req.header("x-forwarded-for");';
    expect(findForbidden("src/auth/rate-limit.ts", sample)).toEqual([]);
    expect(findForbidden("src/auth/other.ts", sample).length).toBeGreaterThan(0);
    expect(
      findForbidden("src/auth/rate-limit.ts", 'const a = c.req.header("x-forwarded-host");').length,
    ).toBeGreaterThan(0);
    expect(findForbidden("src/auth/rate-limit.ts", "const a = c.req.url;").length).toBeGreaterThan(
      0,
    );
  });

  it("reports the file and the line of a finding", () => {
    const findings = findForbidden("src/mcp/x.ts", "const ok = 1;\nconst a = c.req.url;\n");
    expect(findings).toEqual([{ file: "src/mcp/x.ts", line: 2, rule: RULES[0]?.name }]);
  });
});
