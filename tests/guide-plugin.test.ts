import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");
const read = (name: string): string => readFileSync(resolve(ROOT, name), "utf8");

const guide = read("docs/GUIDE-plugin.md");
const mcpGuide = read("docs/GUIDE-mcp.md");
const readme = read("README.md");
const pluginReadme = read("plugin/README.md");
const v2 = read("docs/v2.md");
const manifest = JSON.parse(read("plugin/.claude-plugin/plugin.json")) as {
  userConfig: Record<string, { default?: unknown }>;
};
const schema = JSON.parse(read("plugin/prompts/result.schema.json")) as {
  properties: { status: { enum: string[] } };
};

const EM_DASH = String.fromCodePoint(0x2014);

const REQUIRED_CODES = [
  "invalid_input",
  "hook_error",
  "gave_up",
  "invalid_detail",
  "saved",
  "already_saved",
  "nothing_to_save",
  "headless_failed",
  "invalid_field",
  "not_configured",
  "transcript_missing",
  "skipped_trivial",
  "skipped_duplicate",
  "worker_error",
  "failed",
  "mcp_unavailable",
  "session_type_missing",
  "api_helper_present",
  "claude_not_found",
  "timeout",
];

/** Log codes written as literals in plugin script source text. */
function collectCodes(source: string): string[] {
  const found = new Set<string>();
  const logCall =
    /\b(?:safeLog|failLog|log)(?:\?\.)?\(\s*[\w.]+(?:\([^()]*\))?\s*,\s*"([a-z][a-z0-9_]*)"/g;
  const field = /\b(?:code|error):\s*"([a-z][a-z0-9_]*)"/g;
  for (const re of [logCall, field]) {
    for (const m of source.matchAll(re)) if (m[1] !== undefined) found.add(m[1]);
  }
  return [...found];
}

function mjsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return mjsFiles(path);
    return path.endsWith(".mjs") ? [path] : [];
  });
}

const collected = (() => {
  const set = new Set<string>();
  for (const file of mjsFiles(resolve(ROOT, "plugin/scripts"))) {
    for (const code of collectCodes(readFileSync(file, "utf8"))) set.add(code);
  }
  for (const status of schema.properties.status.enum) set.add(status);
  return [...set].sort();
})();

describe("docs/GUIDE-plugin.md install and connection", () => {
  const literals = [
    "/plugin marketplace add",
    "/plugin install 2brain",
    "claude plugin marketplace add",
    "claude plugin install 2brain@2brain-logic",
    "claude --plugin-dir plugin",
    "claude plugin --help",
    "claude mcp add --scope user --transport http brain <PUBLIC_BASE_URL>/mcp",
    "claude mcp login brain",
    "/mcp",
    "TWOBRAIN_AREA",
    'session: { value: session, folder: "{area}/sessions" }',
    "Do not pre-approve other MCP write tools",
    "logs/capture.log",
    "capture.log.1",
    "CLAUDE_PLUGIN_DATA",
    "analizar-reunion",
    "USD 0",
  ];
  for (const literal of literals) {
    it(`contains ${literal}`, () => {
      expect(guide).toContain(literal);
    });
  }

  it("shows working configure commands and the disable instruction", () => {
    expect(guide).toContain(
      `echo '{"area":"work"}' | claude plugin configure 2brain --values-stdin`,
    );
    expect(guide).toContain(
      `echo '{"enabled":"false"}' | claude plugin configure 2brain --values-stdin`,
    );
    expect(guide).toMatch(/`enabled` setting to `false` \(or `0`\)/);
    expect(guide).toContain("/plugin configure");
  });

  it("README.md has the install commands", () => {
    expect(readme).toContain("/plugin marketplace add");
    expect(readme).toContain("/plugin install 2brain@2brain-logic");
  });

  it("explains that area applies to later sessions and must be a vault area", () => {
    expect(guide).toContain("applies to sessions that end afterwards");
    expect(guide).toContain("one of the `areas`");
  });

  it("tells owners with an allow-list to add claude-code", () => {
    expect(guide).toMatch(/`sources`[^\n]*add `claude-code`/);
  });

  it("never tells the owner to set an ANTHROPIC value", () => {
    expect(guide).not.toContain("ANTHROPIC");
  });

  it("the MCP guide uses the same user-scope command", () => {
    expect(mcpGuide).toContain(
      "claude mcp add --scope user --transport http brain <PUBLIC_BASE_URL>/mcp",
    );
  });
});

describe("docs/GUIDE-plugin.md settings", () => {
  const keys = Object.keys(manifest.userConfig);
  it("reads the keys from plugin.json", () => {
    expect(keys.length).toBeGreaterThan(5);
  });
  for (const key of keys) {
    const def = manifest.userConfig[key]?.default;
    it(`documents ${key} with its default`, () => {
      const lines = guide.split("\n");
      if (def === undefined) {
        expect(lines.some((l) => l.includes(`\`${key}\``) && /\bempty\b/.test(l))).toBe(true);
      } else {
        expect(
          lines.some((l) => l.includes(`\`${key}\``) && l.includes(`\`${String(def)}\``)),
        ).toBe(true);
      }
    });
  }
});

describe("log code collector", () => {
  it("finds a code in a synthetic log call", () => {
    expect(collectCodes('safeLog(id, "foo_bar");')).toContain("foo_bar");
    expect(collectCodes('log?.(idFromName(name), "gave_x");')).toContain("gave_x");
    expect(collectCodes('return { ok: false, code: "baz_qux" };')).toContain("baz_qux");
  });

  it("ignores comparisons with system error codes", () => {
    expect(collectCodes('if (err.code === "ENOENT") {}')).toEqual([]);
  });

  it("collects the required codes", () => {
    expect(collected.length).toBeGreaterThan(0);
    expect(collected.filter((c) => REQUIRED_CODES.includes(c)).sort()).toEqual(
      [...REQUIRED_CODES].sort(),
    );
  });

  it("documents every collected code in the guide", () => {
    expect(collected.filter((code) => !guide.includes(`\`${code}\``))).toEqual([]);
  });
});

describe("other docs", () => {
  it("README.md links to the plugin guide", () => {
    expect(readme).toMatch(/\[[^\]]+\]\(docs\/GUIDE-plugin\.md\)/);
  });

  it("plugin/README.md links to the guide by relative path and has no URL", () => {
    expect(pluginReadme).toMatch(/\[[^\]]+\]\(\.\.\/docs\/GUIDE-plugin\.md\)/);
    expect(pluginReadme).not.toContain("http");
  });

  it("v2.md has the three spec 03 rows", () => {
    const rows = v2.split("\n").filter((l) => l.startsWith("|") && l.includes("| spec 03 |"));
    expect(rows.length).toBe(3);
    expect(rows.some((r) => r.includes("Other coding clients"))).toBe(true);
    expect(rows.some((r) => r.includes("meeting analysis"))).toBe(true);
    expect(rows.some((r) => r.includes("area routing"))).toBe(true);
  });

  it("has no em dash in any T20 file", () => {
    for (const text of [guide, mcpGuide, readme, pluginReadme, v2]) {
      expect(text).not.toContain(EM_DASH);
    }
  });
});
