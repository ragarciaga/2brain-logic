import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CHECK_IDS } from "../src/install/doctor.js";
import { SETUP_USAGE } from "../src/install/setup.js";
import { type ScanFinding, scanOwnerData } from "./plugin/helpers/plugin-scan.js";

const ROOT = resolve(import.meta.dirname, "..");
const read = (name: string): string => readFileSync(resolve(ROOT, name), "utf8");

const guide = read("docs/INSTALL.md");
const mcpGuide = read("docs/GUIDE-mcp.md");
const envExample = read(".env.example");

const EM_DASH = String.fromCodePoint(0x2014);

const HEADINGS = [
  "Prerequisites",
  "Get the code",
  "Create the Docker network",
  "Run setup",
  "Add the deploy key",
  "Start the service",
  "Proxy",
  "Run doctor",
  "Connect claude.ai",
  "Save a first note",
  "n8n credential",
  "Updates",
  "Troubleshooting",
];

/** The setup result codes, as listed in docs/specs/04-installer/design.md. */
const SETUP_CODES = [
  "invalid_answer",
  "remote_not_ssh",
  "missing_answers",
  "project_not_writable",
  "keygen_failed",
  "host_unreachable",
  "host_key_mismatch",
  "host_key_rejected",
  "remote_unreachable",
  "remote_auth_failed",
  "vault_remote_mismatch",
  "config_invalid",
  "push_refused",
  "done",
];

/** Codes the installer emits that are not setup results. */
const ALLOWED_EXTRA = ["usage"];

/** Body of the `## <name>` section, up to the next `## ` heading. */
function section(text: string, name: string): string {
  const lines = text.split("\n");
  const start = lines.indexOf(`## ${name}`);
  if (start === -1) return "";
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i]?.startsWith("## ")) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n");
}

function fences(text: string, lang: string): string[] {
  const re = new RegExp(`\`\`\`${lang}\\n([\\s\\S]*?)\`\`\``, "g");
  return [...text.matchAll(re)].map((m) => m[1] ?? "");
}

/** True when the proxy block forwards the path: a catch-all rule or the path itself. */
function forwards(lang: "caddyfile" | "nginx", block: string, path: string): boolean {
  if (lang === "caddyfile") {
    // A reverse_proxy directly in the site block forwards everything. Drop nested
    // blocks (handle, route) first, since those only forward what they match.
    const topLevel = block.replace(/\n[^\n{}]*\{[^{}]*\}/g, "");
    if (/^\s*reverse_proxy\s+brain:3001\s*$/m.test(topLevel)) return true;
  } else if (/location\s+\/\s*\{/.test(block)) {
    return true;
  }
  return block.includes(path);
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".ts")) out.push(full);
  }
}

describe("docs/INSTALL.md", () => {
  it("has the thirteen sections in order", () => {
    const found = guide
      .split("\n")
      .filter((l) => l.startsWith("## "))
      .map((l) => l.slice(3));
    expect(found).toEqual(HEADINGS);
  });

  it("links the MCP and plugin guides", () => {
    expect(guide).toContain("](GUIDE-mcp.md)");
    expect(guide).toContain("](GUIDE-plugin.md)");
  });

  it("states the Compose minimum and the network command", () => {
    expect(section(guide, "Prerequisites")).toContain("2.24.0");
    expect(section(guide, "Create the Docker network")).toContain("docker network create");
  });

  describe("proxy", () => {
    const proxy = section(guide, "Proxy");
    const caddy = fences(proxy, "caddyfile");
    const nginx = fences(proxy, "nginx");
    const step3 = section(mcpGuide, "3. Put HTTPS in front of the service");
    const paths = [...step3.matchAll(/^- `(\/[^`]*)`/gm)].map((m) => m[1] ?? "");

    it("has one Caddy block and one nginx block, both to brain:3001", () => {
      expect(caddy).toHaveLength(1);
      expect(nginx).toHaveLength(1);
      expect(caddy[0]).toContain("brain:3001");
      expect(nginx[0]).toContain("brain:3001");
      expect(envExample).toMatch(/^MCP_PORT=3001$/m);
      expect(envExample).toMatch(/^PORT=3000$/m);
    });

    it("covers every path the MCP guide lists", () => {
      expect(paths.length).toBeGreaterThanOrEqual(6);
      for (const path of paths) {
        expect(forwards("caddyfile", caddy[0] ?? "", path), `caddy ${path}`).toBe(true);
        expect(forwards("nginx", nginx[0] ?? "", path), `nginx ${path}`).toBe(true);
        expect(proxy).toContain(`\`${path}\``);
      }
    });

    it("the coverage helper rejects a block that forwards only /mcp", () => {
      const partial = "brain.example.com {\n  handle /mcp* {\n    reverse_proxy brain:3001\n  }\n}";
      expect(forwards("caddyfile", partial, "/mcp")).toBe(true);
      expect(forwards("caddyfile", partial, "/token")).toBe(false);
      const partialNginx = "location /mcp { proxy_pass http://brain:3001; }";
      expect(forwards("nginx", partialNginx, "/authorize")).toBe(false);
    });
  });

  it("has the n8n credential values", () => {
    const n8n = section(guide, "n8n credential");
    for (const literal of [
      "Header Auth",
      "2brain ingest",
      "Authorization",
      "Bearer <INGEST_TOKEN>",
      "http://brain:3000",
    ]) {
      expect(n8n).toContain(literal);
    }
  });

  it("lists the update commands in order", () => {
    const updates = section(guide, "Updates");
    const at = ["git pull", "docker compose up -d --build", "docker compose run --rm doctor"].map(
      (c) => updates.indexOf(c),
    );
    expect(at[0]).toBeGreaterThan(-1);
    expect(at[1]).toBeGreaterThan(at[0] ?? 0);
    expect(at[2]).toBeGreaterThan(at[1] ?? 0);
  });

  describe("troubleshooting", () => {
    const trouble = section(guide, "Troubleshooting");

    for (const code of SETUP_CODES) {
      it(`names setup code ${code}`, () => {
        expect(trouble).toContain(`setup: ${code}`);
      });
    }
    for (const id of CHECK_IDS) {
      it(`names doctor check ${id}`, () => {
        expect(trouble).toContain(`fail  ${id}`);
      });
    }

    it("covers the dry-run, insteadOf, secrets ownership, lock and Compose notes", () => {
      expect(trouble).toContain("--dry-run");
      expect(trouble).toContain("push_refused");
      expect(trouble).toContain("insteadof");
      expect(trouble).toContain("insteadOf");
      expect(trouble).toMatch(/secrets\/.{0,80}owned by root[\s\S]{0,80}re-running setup/);
      expect(trouble).toContain("secrets/.setup.lock");
      expect(trouble).toContain("2.24");
    });
  });

  describe("against the source", () => {
    const files: string[] = [];
    walk(join(ROOT, "src"), files);
    const installFiles = files.filter((f) => f.includes("/install/"));
    const installText = installFiles.map((f) => readFileSync(f, "utf8")).join("\n");

    it("every setup code is a literal in src/install", () => {
      for (const code of SETUP_CODES) {
        expect(installText, code).toContain(`"${code}"`);
      }
    });

    it("every code the installer emits is a known setup code", () => {
      const found = new Set<string>();
      const setupText = readFileSync(join(ROOT, "src/install/setup.ts"), "utf8");
      for (const m of setupText.matchAll(/emit\("([a-z_]+)"/g)) found.add(m[1] ?? "");
      for (const m of installText.matchAll(/code: "([a-z_]+)"/g)) found.add(m[1] ?? "");
      const sshText = readFileSync(join(ROOT, "src/install/ssh.ts"), "utf8");
      for (const m of sshText.matchAll(/`([a-z]+_[a-z_]+): /g)) found.add(m[1] ?? "");
      expect(found.size).toBeGreaterThan(8);
      const known = new Set([...SETUP_CODES, ...ALLOWED_EXTRA]);
      expect([...found].filter((c) => !known.has(c))).toEqual([]);
    });

    it("every INSTALL.md reference in src names a real section", () => {
      const names = new Set<string>();
      for (const file of files) {
        const text = readFileSync(file, "utf8");
        for (const m of text.matchAll(/docs\/INSTALL\.md,? ([A-Z][a-z]+)/g)) {
          names.add(m[1] ?? "");
        }
      }
      expect(names.size).toBeGreaterThanOrEqual(2);
      const headings = new Set(
        guide
          .split("\n")
          .filter((l) => l.startsWith("## "))
          .map((l) => l.slice(3)),
      );
      expect([...names].filter((n) => !headings.has(n))).toEqual([]);
    });
  });

  it("shows the exact usage text and a command that prints it", () => {
    const runSetup = section(guide, "Run setup");
    expect(runSetup).toContain(`setup: missing_answers: ${SETUP_USAGE}`);
    expect(runSetup).toContain("docker compose run --rm setup --non-interactive --help");
  });

  it("says which prompts need a public base URL", () => {
    const runSetup = section(guide, "Run setup").replace(/\s+/g, " ");
    expect(runSetup.match(/Asked only when you gave a public base URL/g)?.length).toBe(3);
  });

  it("has no em dash", () => {
    expect(guide).not.toContain(EM_DASH);
  });
});

const readme = read("README.md");

/** Hosts the guides may name besides example.com: product and stack documentation hosts. */
const ALLOWED_HOSTS = new Set([
  "github.com",
  "docs.github.com",
  "nodejs.org",
  "www.typescriptlang.org",
  "typescriptlang.org",
  "hono.dev",
  "zod.dev",
  "docs.claude.com",
  "vitest.dev",
  "biomejs.dev",
  "docs.docker.com",
  "docs.n8n.io",
  "claude.ai",
  "claude.com",
  "chatgpt.com",
  // Not domains: the loopback address and the Compose service name of this product.
  "127.0.0.1",
  "brain",
]);

function hostOf(finding: ScanFinding): string {
  if (finding.rule === "email") return finding.match.slice(finding.match.indexOf("@") + 1);
  if (finding.rule === "url-host") return finding.match.replace(/^https?:\/\//i, "");
  return finding.match;
}

/** scanOwnerData minus the allowed product hosts and the git SSH user. */
function ownerDataFindings(text: string): ScanFinding[] {
  return scanOwnerData(text).filter((f) => {
    if (!["email", "url-host", "hostname"].includes(f.rule)) return true;
    if (f.rule === "email" && f.match === "git@github.com") return false;
    return f.rule === "email" || !ALLOWED_HOSTS.has(hostOf(f).toLowerCase());
  });
}

describe("README.md install (R6.5)", () => {
  const install = section(readme, "Install");

  it("has an Install section linking docs/INSTALL.md", () => {
    expect(install).not.toBe("");
    expect(install).toMatch(/\[[^\]]+\]\((?:\.\/)?docs\/INSTALL\.md\)/);
  });

  it("uses setup in the Install section, not cp", () => {
    expect(install).toContain("docker compose run --rm setup");
    expect(install).not.toContain("cp .env.example .env");
  });

  it("drops the early-version warning", () => {
    expect(readme).not.toContain("throwaway");
    expect(readme).not.toContain("real n8n flows");
  });
});

describe("owner data and em dash (R6.6)", () => {
  for (const [name, text] of [
    ["README.md", readme],
    ["docs/INSTALL.md", guide],
  ] as const) {
    it(`${name} has no owner data`, () => {
      expect(ownerDataFindings(text)).toEqual([]);
    });
    it(`${name} has no em dash`, () => {
      expect(text).not.toContain(EM_DASH);
    });
  }

  it("the filter still catches owner data", () => {
    expect(ownerDataFindings("li@acme.org").map((f) => f.rule)).toEqual(["email", "hostname"]);
    expect(ownerDataFindings("https://brain.test/x").map((f) => f.rule)).toContain("url-host");
    expect(ownerDataFindings("Carla").map((f) => f.rule)).toEqual(["person-name"]);
    expect(ownerDataFindings("user@github.com").map((f) => f.rule)).toContain("email");
    expect(ownerDataFindings("see example.org").map((f) => f.rule)).toEqual(["hostname"]);
  });

  it("the filter allows the product hosts and the git SSH user", () => {
    expect(ownerDataFindings("git@github.com:x/y.git")).toEqual([]);
    expect(ownerDataFindings("claude.ai")).toEqual([]);
    expect(ownerDataFindings("https://brain.example.com")).toEqual([]);
  });
});
