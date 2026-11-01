import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_VAULT_CONFIG } from "../src/config/defaults.js";
import {
  ConfigInvalidError,
  loadVaultConfig,
  requireMeetingSetup,
} from "../src/config/vault-config.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "2brain-meetings-config-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeConfig(text: string): void {
  mkdirSync(join(dir, ".2brain"), { recursive: true });
  writeFileSync(join(dir, ".2brain", "config.yaml"), text);
}

async function errorOf(promise: Promise<unknown>): Promise<ConfigInvalidError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigInvalidError);
    return error as ConfigInvalidError;
  }
  throw new Error("did not throw");
}

describe("meetings config defaults", () => {
  it("no meetings section uses defaults", async () => {
    writeConfig("version: 1\n");
    const config = await loadVaultConfig(dir);
    expect(config.meetings).toStrictEqual(DEFAULT_VAULT_CONFIG.meetings);
    expect(config.version).toBe(1);
    expect(config.meetings.timezone).toBe("UTC");
    expect(config.meetings.min_minutes).toBe(5);
    expect(config.meetings.untitled_label).toBe("Untitled meeting");
    expect(config.meetings.unknown_speaker_label).toBe("Speaker");
    expect(config.meetings.default_area).toBeNull();
    expect(config.meetings.area_rules).toStrictEqual([]);
    expect(config.meetings.sources.fireflies).toStrictEqual({
      value: "fireflies",
      label: "Fireflies",
    });
    expect(config.meetings.sources.gemini).toStrictEqual({ value: "gemini", label: "Gemini" });
    expect(Object.keys(config.meetings.properties)).toHaveLength(8);
    expect(config.meetings.properties.duration).toBe("duration_minutes");
  });

  it("an empty meetings section uses defaults", async () => {
    writeConfig("meetings: {}\n");
    expect((await loadVaultConfig(dir)).meetings).toStrictEqual(DEFAULT_VAULT_CONFIG.meetings);
  });

  it("partial section keeps other defaults", async () => {
    writeConfig("meetings:\n  timezone: America/Bogota\n");
    expect((await loadVaultConfig(dir)).meetings).toStrictEqual({
      ...DEFAULT_VAULT_CONFIG.meetings,
      timezone: "America/Bogota",
    });
  });
});

describe("meetings config accepted inputs", () => {
  it("accepts rules with only domain or only calendar, and a configured default area", async () => {
    writeConfig(
      [
        "meetings:",
        "  default_area: work",
        "  area_rules:",
        "    - { area: work, domain: example.com }",
        "    - { area: personal, calendar: team@example.com }",
        "",
      ].join("\n"),
    );
    const { meetings } = await loadVaultConfig(dir);
    expect(meetings.default_area).toBe("work");
    expect(meetings.area_rules).toStrictEqual([
      { area: "work", domain: "example.com" },
      { area: "personal", calendar: "team@example.com" },
    ]);
  });

  it.each([0, 120])("accepts min_minutes %i", async (minutes) => {
    writeConfig(`meetings:\n  min_minutes: ${minutes}\n`);
    expect((await loadVaultConfig(dir)).meetings.min_minutes).toBe(minutes);
  });

  it("accepts renamed meeting properties", async () => {
    writeConfig("meetings:\n  properties:\n    start: began\n");
    expect((await loadVaultConfig(dir)).meetings.properties.start).toBe("began");
  });
});

describe("meetings config rejections", () => {
  it.each([
    ["an unknown meetings key", "meetings:\n  colour: red\n", "meetings.colour"],
    [
      "an unknown source key",
      "meetings:\n  sources:\n    fireflies: { value: f, label: F, colour: red }\n",
      "meetings.sources.fireflies.colour",
    ],
    [
      "an unknown rule key",
      "meetings:\n  area_rules:\n    - { area: work, domain: example.com, colour: red }\n",
      "meetings.area_rules.0.colour",
    ],
    [
      "a rule area not in areas",
      "meetings:\n  area_rules:\n    - { area: nowhere, domain: example.com }\n",
      "meetings.area_rules.0.area",
    ],
    [
      "a default area not in areas",
      "meetings:\n  default_area: nowhere\n",
      "meetings.default_area",
    ],
    [
      "a rule with domain and calendar",
      "meetings:\n  area_rules:\n    - { area: work, domain: example.com, calendar: a@example.com }\n",
      "meetings.area_rules.0",
    ],
    [
      "a rule with neither domain nor calendar",
      "meetings:\n  area_rules:\n    - { area: work }\n",
      "meetings.area_rules.0",
    ],
    ["an unknown timezone", "meetings:\n  timezone: Mars/Base\n", "meetings.timezone"],
    ["a negative min_minutes", "meetings:\n  min_minutes: -1\n", "meetings.min_minutes"],
    ["min_minutes above 120", "meetings:\n  min_minutes: 121\n", "meetings.min_minutes"],
    ["a fractional min_minutes", "meetings:\n  min_minutes: 2.5\n", "meetings.min_minutes"],
    [
      "duplicate meeting properties",
      "meetings:\n  properties:\n    start: when\n    end: when\n",
      "meetings.properties",
    ],
    [
      "a meeting property equal to a canonical name",
      "meetings:\n  properties:\n    start: date\n",
      "meetings.properties.start",
    ],
    [
      "a meeting property equal to a renamed owner name",
      "properties:\n  type: kind\nmeetings:\n  properties:\n    start: kind\n",
      "meetings.properties.start",
    ],
    [
      "a meeting property equal to analysis",
      "meetings:\n  properties:\n    versions: analysis\n",
      "meetings.properties.versions",
    ],
    [
      "equal source values",
      "meetings:\n  sources:\n    gemini: { value: fireflies, label: Gemini }\n",
      "meetings.sources.gemini.value",
    ],
    [
      "a source label with a slash",
      "meetings:\n  sources:\n    gemini: { value: gemini, label: a/b }\n",
      "meetings.sources.gemini.label",
    ],
    [
      "a source label with a backslash",
      'meetings:\n  sources:\n    gemini: { value: gemini, label: "a\\\\b" }\n',
      "meetings.sources.gemini.label",
    ],
    [
      "a source label with a control character",
      'meetings:\n  sources:\n    gemini: { value: gemini, label: "a\\tb" }\n',
      "meetings.sources.gemini.label",
    ],
    [
      "a source label of two dots",
      'meetings:\n  sources:\n    fireflies: { value: fireflies, label: ".." }\n',
      "meetings.sources.fireflies.label",
    ],
    [
      "a source label of one dot",
      'meetings:\n  sources:\n    fireflies: { value: fireflies, label: "." }\n',
      "meetings.sources.fireflies.label",
    ],
    [
      "an empty source label",
      'meetings:\n  sources:\n    fireflies: { value: fireflies, label: "" }\n',
      "meetings.sources.fireflies.label",
    ],
  ])("rejects %s", async (_name, yaml, keyPath) => {
    writeConfig(yaml);
    const error = await errorOf(loadVaultConfig(dir));
    expect(error.keyPath).toBe(keyPath);
    expect(error.message).toContain(".2brain/config.yaml");
    expect(error.message).toContain(keyPath);
  });
});

describe("requireMeetingSetup", () => {
  it("meeting checks do not block other writes", async () => {
    const cases: [string, string][] = [
      ["types:\n  note: { value: x }\n", "types.meeting"],
      ["types:\n  meeting: { value: meeting }\n", "types.meeting"],
      ["sources: [gmail, fireflies]\n", "sources"],
      [
        "sources: [gmail, fireflies, gemini]\nmeetings:\n  sources:\n    gemini: { value: g2, label: G }\n",
        "sources",
      ],
    ];
    for (const [yaml, keyPath] of cases) {
      writeConfig(yaml);
      const config = await loadVaultConfig(dir);
      let thrown: unknown;
      try {
        requireMeetingSetup(config);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ConfigInvalidError);
      expect((thrown as ConfigInvalidError).keyPath).toBe(keyPath);
      expect((thrown as ConfigInvalidError).message).toContain(".2brain/config.yaml");
    }
  });

  it("passes for the defaults, an empty allow-list and a full allow-list", async () => {
    requireMeetingSetup(DEFAULT_VAULT_CONFIG);
    writeConfig("sources: []\n");
    requireMeetingSetup(await loadVaultConfig(dir));
    writeConfig("sources: [fireflies, gemini, gmail]\n");
    requireMeetingSetup(await loadVaultConfig(dir));
  });
});
