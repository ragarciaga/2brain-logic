import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_VAULT_CONFIG } from "../src/config/defaults.js";
import { VaultConfigSchema } from "../src/config/vault-config.js";
import { parseYamlConfig } from "../src/vault/frontmatter.js";
import {
  loadTemplate,
  type N8nNode,
  type N8nTemplate,
  nodeByName,
} from "./helpers/n8n-template.js";
import { scanOwnerData } from "./plugin/helpers/plugin-scan.js";

const ROOT = resolve(import.meta.dirname, "..");
const read = (name: string): string => readFileSync(resolve(ROOT, name), "utf8");

const guide = read("docs/GUIDE-meetings.md");
const install = read("docs/INSTALL.md");
const fireflies = loadTemplate(resolve(ROOT, "n8n/templates/meetings-fireflies.json"));
const gemini = loadTemplate(resolve(ROOT, "n8n/templates/meetings-gemini.json"));
const templates: N8nTemplate[] = [fireflies, gemini];
const vaultConfig = parseYamlConfig(read("vault-template/.2brain/config.yaml")) as {
  meetings: Record<string, unknown> & {
    sources: Record<string, { value: string }>;
    min_minutes: number;
  };
};

const EM_DASH = String.fromCodePoint(0x2014);

const HEADINGS = [
  "Before you start",
  "Import the templates",
  "Credentials",
  "Fireflies: poll or webhook mode",
  "Fireflies: poll interval and daily budget",
  "Fireflies webhook mode",
  "Activate the workflows",
  "Google Meet: Workspace edition and Meet REST API",
  "Meetings config",
  "Source allow-list",
  "Skips and retries",
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

/** True when some line of `text` contains every needle. */
const hasLine = (text: string, ...needles: string[]): boolean =>
  text.split("\n").some((l) => needles.every((n) => l.includes(n)));

const param = (node: N8nNode, key: string): unknown => node.parameters?.[key];

interface Assignment {
  name: string;
  value: string | number;
}
function settingsOf(t: N8nTemplate): Assignment[] {
  const p = nodeByName(t, "Settings").parameters as {
    assignments: { assignments: Assignment[] };
  };
  return p.assignments.assignments;
}

const CRED_LABELS: Record<string, string> = {
  httpHeaderAuth: "Header Auth",
  googleCalendarOAuth2Api: "Google Calendar OAuth2 API",
  googleOAuth2Api: "Google OAuth2 API",
};

function pollStateCode(): string {
  return String(param(nodeByName(fireflies, "Poll state"), "jsCode"));
}
function constant(re: RegExp): number {
  const m = re.exec(pollStateCode());
  if (!m) throw new Error(`no match for ${re}`);
  return Number(m[1]);
}

const PRICE = /[$€£¥]|\bUSD\b/;

describe("docs/GUIDE-meetings.md", () => {
  it("has the twelve sections in order", () => {
    const found = guide
      .split("\n")
      .filter((l) => l.startsWith("## "))
      .map((l) => l.slice(3));
    expect(found).toEqual(HEADINGS);
  });

  it("INSTALL links the guide from the n8n credential section", () => {
    expect(section(install, "n8n credential")).toContain("](GUIDE-meetings.md)");
  });

  it("names the credentials and their types as the templates do", () => {
    const creds = new Map<string, string>();
    for (const t of templates) {
      for (const n of t.nodes) {
        for (const [key, c] of Object.entries(n.credentials ?? {})) {
          creds.set(String(c.name), key);
        }
      }
    }
    expect([...creds.keys()].sort()).toEqual([
      "2brain ingest",
      "Fireflies API",
      "Google Calendar",
      "Google Meet",
    ]);
    const body = section(guide, "Credentials");
    for (const [name, key] of creds) {
      const label = CRED_LABELS[key];
      expect(label, `label for ${key}`).toBeDefined();
      expect(hasLine(body, `\`${name}\``, label ?? ""), name).toBe(true);
    }
    expect(body).toContain("https://www.googleapis.com/auth/calendar.readonly");
    expect(body).toContain("https://www.googleapis.com/auth/meetings.space.readonly");
  });

  it("lists every Settings field and default of both templates", () => {
    for (const t of templates) {
      const list = settingsOf(t);
      expect(list.length).toBeGreaterThan(0);
      for (const a of list) {
        expect(hasLine(guide, `\`${a.name}\``, `\`${a.value}\``), a.name).toBe(true);
      }
    }
  });

  it("states the interval, the setting that the schedule ignores and the budget math", () => {
    const body = section(guide, "Fireflies: poll interval and daily budget");
    const schedule = param(nodeByName(fireflies, "Poll schedule"), "rule") as {
      interval: { minutesInterval: number }[];
    };
    const interval = schedule.interval[0]?.minutesInterval;
    const settings = settingsOf(fireflies);
    const setting = settings.find((a) => a.name === "poll_interval_minutes");
    const budget = settings.find((a) => a.name === "daily_budget");
    expect(interval).toBe(setting?.value);
    for (const t of templates) {
      for (const n of t.nodes) {
        if (n.name === "Settings") continue;
        expect(JSON.stringify(n), n.name).not.toContain("poll_interval_minutes");
      }
    }
    expect(body).toContain("`Poll schedule`");
    expect(body).toMatch(/does not read `poll_interval_minutes`/);
    const lists = 1440 / Number(interval);
    const fetches = Number(budget?.value) - lists;
    expect(hasLine(body, "`1440/interval`", String(lists))).toBe(true);
    expect(hasLine(body, "`daily_budget - 24`", String(fetches))).toBe(true);
    expect(lists).toBe(24);
  });

  it("explains webhook mode from the template", () => {
    const hook = nodeByName(fireflies, "Fireflies webhook");
    expect(hook.disabled).toBe(true);
    expect(nodeByName(fireflies, "Poll schedule").disabled).not.toBe(true);
    const path = String(param(hook, "path"));
    const body = section(guide, "Fireflies webhook mode");
    expect(body).toContain(`\`${path}\``);
    const cond = param(nodeByName(fireflies, "Completed only"), "conditions") as {
      conditions: { rightValue: string }[];
    };
    const event = cond.conditions[0]?.rightValue ?? "";
    expect(event).not.toBe("");
    expect(body).toContain(event);
  });

  it("states the retry counts, waits and stop nodes of the templates", () => {
    const body = section(guide, "Skips and retries");
    expect(constant(/const MAX_TRIES = (\d+)/)).toBe(3);
    const posts = constant(/const MAX_POSTS = (\d+)/);
    const hours = constant(/const WINDOW_MS = (\d+) \* 60/);
    expect(body).toContain(`${posts} posts`);
    expect(body).toContain(`${hours} hours`);
    for (const t of templates) {
      const wait = nodeByName(t, "Post wait").parameters as { amount: number; unit: string };
      expect(body).toContain(`${wait.amount} ${wait.unit}`);
      const cal = nodeByName(t, "Calendar events");
      expect(cal.maxTries).toBe(3);
      expect(body).toContain(`${cal.maxTries} tries`);
      expect(body).toContain(`${Number(cal.waitBetweenTries) / 1000} seconds`);
      const stops = t.nodes.filter((n) => n.type === "n8n-nodes-base.stopAndError");
      expect(stops.length).toBeGreaterThan(0);
      for (const s of stops) expect(body, s.name).toContain(`\`${s.name}\``);
    }
    const finished = param(nodeByName(gemini, "Finished only"), "conditions") as {
      conditions: { rightValue: string }[];
    };
    expect(body).toContain(String(finished.conditions[0]?.rightValue));
    for (const word of [
      "too_short",
      "empty_transcript",
      "already_stored",
      "502",
      "503",
      "config_invalid",
    ]) {
      expect(guide, word).toContain(word);
    }
    expect(body).toContain(`\`min_minutes\` (default ${vaultConfig.meetings.min_minutes})`);
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

  it("lists the Fireflies daily API request limit as a prerequisite", () => {
    expect(section(guide, "Before you start")).toMatch(/daily API request limit/);
  });

  it("has no price", () => {
    expect(guide).not.toMatch(PRICE);
  });

  it("the price check catches a price", () => {
    expect("USD 5").toMatch(PRICE);
    expect("costs $5").toMatch(PRICE);
  });

  it("has no owner data", () => {
    // The ingest URL and the OAuth scope URLs are product facts, not owner data. The scan reads
    // their path tails as vault paths, so they are removed before scanning.
    const post = String(param(nodeByName(fireflies, "Post meeting"), "url"));
    const scopes = guide.match(/https:\/\/www\.googleapis\.com\/auth\/[a-z.]+/g) ?? [];
    expect(scopes.length).toBeGreaterThan(0);
    let text = guide.split(post).join("");
    for (const scope of scopes) text = text.split(scope).join("");
    const allowed = ["www.googleapis.com", "brain"];
    const found = scanOwnerData(text).filter((f) => !allowed.some((a) => f.match.includes(a)));
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
