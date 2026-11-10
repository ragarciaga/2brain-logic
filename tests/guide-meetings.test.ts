import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_VAULT_CONFIG } from "../src/config/defaults.js";
import { VaultConfigSchema } from "../src/config/vault-config.js";
import { parseYamlConfig } from "../src/vault/frontmatter.js";
import { loadTemplate, type N8nTemplate, nodeByName } from "./helpers/n8n-template.js";
import { scanOwnerData } from "./plugin/helpers/plugin-scan.js";

const ROOT = resolve(import.meta.dirname, "..");
const read = (name: string): string => readFileSync(resolve(ROOT, name), "utf8");

const guide = read("docs/GUIDE-meetings.md");
const install = read("docs/INSTALL.md");
const template = loadTemplate(resolve(ROOT, "n8n/templates/meetings-import.json"));
const vaultConfig = parseYamlConfig(read("vault-template/.2brain/config.yaml")) as {
  meetings: Record<string, unknown> & {
    sources: Record<string, { value: string }>;
    min_minutes: number;
  };
};

const EM_DASH = String.fromCodePoint(0x2014);

const HEADINGS = [
  "Before you start",
  "How an import runs",
  "Import the template",
  "Credentials",
  "Settings",
  "Connect the service",
  "Activate the workflow",
  "Meetings config",
  "Source allow-list",
  "Skips and failures",
  "Privacy",
];

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

const PRICE = /[$€£¥]|\bUSD\b/;

const credentialNames = (t: N8nTemplate): string[] => {
  const names = new Set<string>();
  for (const node of t.nodes) {
    for (const cred of Object.values(node.credentials ?? {})) names.add(String(cred.name));
  }
  return [...names].sort();
};

const settingsNames = (t: N8nTemplate): string[] =>
  (
    nodeByName(t, "Settings").parameters as {
      assignments: { assignments: { name: string }[] };
    }
  ).assignments.assignments.map((a) => a.name);

describe("docs/GUIDE-meetings.md", () => {
  it("has its sections in order", () => {
    const found = guide
      .split("\n")
      .filter((l) => l.startsWith("## "))
      .map((l) => l.slice(3));
    expect(found).toEqual(HEADINGS);
  });

  it("INSTALL links the guide from the n8n credential section", () => {
    expect(install).toContain("GUIDE-meetings.md");
  });

  it("names every credential of the template", () => {
    const body = section(guide, "Credentials");
    for (const name of credentialNames(template)) expect(body).toContain(`\`${name}\``);
  });

  it("lists every Settings field the owner fills, except days", () => {
    const body = section(guide, "Settings");
    for (const name of settingsNames(template).filter((n) => n !== "days")) {
      expect(body).toContain(`\`${name}\``);
    }
  });

  it("gives the webhook address the template serves and the variable the service reads", () => {
    const path = String(nodeByName(template, "Import request").parameters?.path);
    const body = section(guide, "Connect the service");
    expect(body).toContain(`/webhook/${path}`);
    expect(body).toContain("MEETINGS_IMPORT_URL");
  });

  it("states the daily sweep time of the template", () => {
    const rule = nodeByName(template, "Daily sweep").parameters as {
      rule: { interval: { triggerAtHour: number; triggerAtMinute: number }[] };
    };
    const at = rule.rule.interval[0];
    const time = `${String(at?.triggerAtHour).padStart(2, "0")}:${String(at?.triggerAtMinute).padStart(2, "0")}`;
    expect(section(guide, "How an import runs")).toContain(time);
  });

  it("states the skip rule with the template default", () => {
    expect(section(guide, "Skips and failures")).toContain(
      `\`min_minutes\` (default ${vaultConfig.meetings.min_minutes})`,
    );
  });

  describe("config example", () => {
    const block = fences(section(guide, "Meetings config"), "yaml");

    it("has one block that equals the template defaults plus one area rule", () => {
      expect(block).toHaveLength(1);
      const parsed = parseYamlConfig(block[0] ?? "") as {
        meetings: { area_rules: { domain?: string; area: string }[] };
      };
      const { area_rules: rules, ...rest } = parsed.meetings;
      expect(rules).toHaveLength(1);
      expect(rules[0]?.domain).toBe("example.com");
      expect(DEFAULT_VAULT_CONFIG.areas).toContain(rules[0]?.area);
      const { area_rules: _ignored, ...expected } = vaultConfig.meetings;
      expect(rest).toStrictEqual(expected);
      expect(VaultConfigSchema.safeParse(parsed).success).toBe(true);
    });
  });

  it("tells the owner to extend a non-empty sources allow-list", () => {
    const values = Object.values(vaultConfig.meetings.sources).map((s) => s.value);
    expect(values).toEqual(["fireflies", "gemini"]);
    const body = section(guide, "Source allow-list");
    const re = new RegExp(`\`sources\`[^\\n]*\`${values[0]}\`[^\\n]*\`${values[1]}\``);
    expect(body).toMatch(re);
  });

  it("lists the Fireflies and Composio limits as prerequisites", () => {
    const body = section(guide, "Before you start");
    expect(body).toMatch(/daily API request limit/);
    expect(body).toMatch(/Composio plan's monthly limit/);
  });

  it("has no price", () => {
    expect(guide).not.toMatch(PRICE);
  });

  it("the price check catches a price", () => {
    expect("USD 5").toMatch(PRICE);
    expect("costs $5").toMatch(PRICE);
  });

  it("has no owner data", () => {
    // Service and n8n addresses on the Docker network and the doc name pattern are product facts.
    const allowed = ["brain", "n8n", "3000/meetings"];
    const found = scanOwnerData(guide).filter((f) => !allowed.some((a) => f.match.includes(a)));
    expect(found).toEqual([]);
  });

  it("the owner data scan flags an email, a host and a name", () => {
    expect(scanOwnerData("write to li@acme.org").length).toBeGreaterThan(0);
    expect(scanOwnerData("see acme.org").length).toBeGreaterThan(0);
    expect(scanOwnerData("Carla joined").length).toBeGreaterThan(0);
  });

  it("has no em dash", () => {
    expect(guide).not.toContain(EM_DASH);
    expect(`a ${EM_DASH} b`).toContain(EM_DASH);
  });
});
