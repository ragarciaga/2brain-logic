import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { TOKEN_LIFETIMES } from "../src/auth/oauth/token.js";
import { MIN_PASSPHRASE_LENGTH, SIGNIN_LOCKOUT } from "../src/auth/owner.js";
import { RATE_RULES } from "../src/auth/rate-limit.js";

const ROOT = resolve(import.meta.dirname, "..");
const read = (name: string): string => readFileSync(resolve(ROOT, name), "utf8");

const guide = read("docs/GUIDE-mcp.md");
const readme = read("README.md");
const envExample = read(".env.example");

const EM_DASH = String.fromCharCode(0x2014);

/** Env-var-shaped tokens: upper case words joined by underscores. */
function envTokens(text: string): string[] {
  return [...new Set(text.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g) ?? [])].sort();
}

/** Names defined as `NAME=` at the start of a line. */
function definedNames(text: string): Set<string> {
  const names = new Set<string>();
  for (const line of text.split("\n")) {
    const match = /^([A-Z][A-Z0-9_]*)=/.exec(line);
    if (match?.[1] !== undefined) names.add(match[1]);
  }
  return names;
}

/** True when the text has a Markdown link whose target is the guide. */
function linksToGuide(text: string): boolean {
  return /\[[^\]]+\]\((?:\.\/)?docs\/GUIDE-mcp\.md\)/.test(text);
}

describe("docs/GUIDE-mcp.md", () => {
  const literals = [
    "node dist/cli.js hash-passphrase",
    "PUBLIC_BASE_URL",
    "OWNER_PASSPHRASE_HASH",
    "AUTH_STORE_DIR",
    "MCP_PORT",
    "TRUST_PROXY_HOPS",
    "<PUBLIC_BASE_URL>/mcp",
    "invalid_target",
    "claude mcp add --scope user --transport http brain <PUBLIC_BASE_URL>/mcp",
    "custom connector",
    "Codex",
    "ChatGPT",
  ];
  for (const literal of literals) {
    it(`contains ${literal}`, () => {
      expect(guide).toContain(literal);
    });
  }

  for (const tool of [
    "search",
    "read",
    "recent",
    "save_note",
    "save_recipe",
    "update_properties",
    "vault_info",
  ]) {
    it(`names the tool ${tool}`, () => {
      expect(guide).toContain(`\`${tool}\``);
    });
  }

  it("says seven tools, describes vault_info as read only and no longer says six", () => {
    expect(guide).toContain("seven tools");
    expect(guide).not.toContain("six tools");
    expect(guide).toMatch(/- `vault_info`: read only;/);
  });

  it("shows the Claude Code block at user scope, then the headless reason", () => {
    const block =
      "```bash\nclaude mcp add --scope user --transport http brain <PUBLIC_BASE_URL>/mcp\n```";
    const at = guide.indexOf(block);
    expect(at).toBeGreaterThan(-1);
    expect(guide.slice(at + block.length)).toContain("headless");
  });

  it("says there is no delete tool", () => {
    expect(guide).toContain("no delete tool");
  });

  it("states the passphrase minimum and the global sign-in limit from the code", () => {
    expect(guide).toContain(`${MIN_PASSPHRASE_LENGTH} characters`);
    expect(guide).toContain(`${RATE_RULES.signin.globalLimit} sign-in attempts per minute`);
  });

  it("states the lockout, per-address, registration and token numbers from the code", () => {
    const minutes = SIGNIN_LOCKOUT.windowMs / 60_000;
    const lockMinutes = SIGNIN_LOCKOUT.lockMs / 60_000;
    expect(guide).toContain(
      `${SIGNIN_LOCKOUT.maxAttempts} wrong attempts within ${minutes} minutes lock that address for ${lockMinutes} minutes`,
    );
    expect(guide).toContain(`${RATE_RULES.signin.limit} sign-in attempts per minute`);
    expect(guide).toContain(
      `${RATE_RULES.register.limit} per hour per address and ${RATE_RULES.register.globalLimit} per hour in total`,
    );
    expect(guide).toContain(`access token lasts ${TOKEN_LIFETIMES.accessMs / 3_600_000} hour`);
    expect(guide).toContain(`refresh token ${TOKEN_LIFETIMES.refreshMs / 86_400_000} days`);
    expect(RATE_RULES.signin.windowMs).toBe(60_000);
    expect(RATE_RULES.register.windowMs).toBe(3_600_000);
  });

  it("defines every env var it mentions in .env.example", () => {
    const defined = definedNames(envExample);
    const mentioned = envTokens(guide);
    expect(mentioned.length).toBeGreaterThan(5);
    expect(mentioned.filter((name) => !defined.has(name))).toEqual([]);
  });

  it("the env token check can fail", () => {
    expect(envTokens("set FAKE_VARIABLE_X now")).toEqual(["FAKE_VARIABLE_X"]);
    expect(definedNames(envExample).has("FAKE_VARIABLE_X")).toBe(false);
  });

  it("has no em dash", () => {
    expect(guide).not.toContain(EM_DASH);
  });
});

describe("README.md", () => {
  it("links to the guide", () => {
    expect(linksToGuide(readme)).toBe(true);
  });

  it("the link check rejects plain text and a wrong target", () => {
    expect(linksToGuide("see docs/GUIDE-mcp.md")).toBe(false);
    expect(linksToGuide("[guide](docs/OTHER.md)")).toBe(false);
  });

  it("has no em dash", () => {
    expect(readme).not.toContain(EM_DASH);
  });
});
