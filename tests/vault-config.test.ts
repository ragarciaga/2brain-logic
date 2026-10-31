import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_VAULT_CONFIG } from "../src/config/defaults.js";
import {
  ConfigInvalidError,
  expandTypeFolders,
  loadVaultConfig,
} from "../src/config/vault-config.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "2brain-config-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeConfig(text: string): void {
  mkdirSync(join(dir, ".2brain"), { recursive: true });
  writeFileSync(join(dir, ".2brain", "config.yaml"), text);
}

async function loadError(): Promise<ConfigInvalidError> {
  try {
    await loadVaultConfig(dir);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigInvalidError);
    return error as ConfigInvalidError;
  }
  throw new Error("loadVaultConfig did not throw");
}

async function expectInvalid(yaml: string, keyPath: string): Promise<void> {
  writeConfig(yaml);
  const error = await loadError();
  expect(error.file).toBe(".2brain/config.yaml");
  expect(error.keyPath).toBe(keyPath);
  expect(error.message).toContain(".2brain/config.yaml");
}

describe("loadVaultConfig defaults", () => {
  it("returns the default config when the file is absent", async () => {
    expect(await loadVaultConfig(dir)).toStrictEqual(DEFAULT_VAULT_CONFIG);
  });

  it("uses archive as the default archive folder", async () => {
    expect((await loadVaultConfig(dir)).vault.archive_folder).toBe("archive");
  });

  it("returns a fresh object on every load", async () => {
    const snapshot = structuredClone(DEFAULT_VAULT_CONFIG);
    const first = await loadVaultConfig(dir);
    first.areas.push("mutated");
    first.vault.archive_folder = "mutated";
    first.properties.type = "mutated";
    expect(await loadVaultConfig(dir)).toStrictEqual(snapshot);
    expect(DEFAULT_VAULT_CONFIG).toStrictEqual(snapshot);
  });

  it("returns a fresh object when the file leaves sections out", async () => {
    writeConfig("version: 1\n");
    const snapshot = structuredClone(DEFAULT_VAULT_CONFIG);
    const first = await loadVaultConfig(dir);
    first.types.meeting = { value: "mutated" };
    first.sources.push("mutated");
    first.areas.push("mutated");
    expect(await loadVaultConfig(dir)).toStrictEqual(snapshot);
    expect(DEFAULT_VAULT_CONFIG).toStrictEqual(snapshot);
  });

  it("gives the defaults for an empty file", async () => {
    writeConfig("");
    expect(await loadVaultConfig(dir)).toStrictEqual(DEFAULT_VAULT_CONFIG);
  });

  it("gives the defaults for a file that only has a --- marker", async () => {
    writeConfig("---\n");
    expect(await loadVaultConfig(dir)).toStrictEqual(DEFAULT_VAULT_CONFIG);
  });

  it("defaults the vault folders when the vault section is empty", async () => {
    writeConfig("vault: {}\n");
    expect((await loadVaultConfig(dir)).vault).toStrictEqual({
      archive_folder: "archive",
      inbox_folder: "inbox",
    });
  });
});

describe("loadVaultConfig mappings", () => {
  it("returns the file's archive folder, also after a leading --- marker", async () => {
    writeConfig("---\nvault:\n  archive_folder: old/stuff\n");
    const config = await loadVaultConfig(dir);
    expect(config.vault.archive_folder).toBe("old/stuff");
    expect(config.vault.inbox_folder).toBe("inbox");
  });

  it("exposes the owner's property names and keeps the others canonical", async () => {
    writeConfig("properties:\n  type: kind\n  source_id: external_id\n");
    expect((await loadVaultConfig(dir)).properties).toStrictEqual({
      type: "kind",
      area: "area",
      date: "date",
      source: "source",
      source_id: "external_id",
    });
  });

  it("reads a full config", async () => {
    writeConfig(
      [
        "version: 1",
        "vault: { archive_folder: done, inbox_folder: unsorted }",
        "properties: { type: kind, area: zone, date: day, source: origin, source_id: origin_id }",
        "areas: [home, office]",
        "sources: [fireflies, gmail]",
        "types:",
        '  meeting: { value: call, folder: "{area}/calls", immutable_body: true }',
        "  note: { value: scribble }",
        "",
      ].join("\n"),
    );
    expect(await loadVaultConfig(dir)).toStrictEqual({
      version: 1,
      vault: { archive_folder: "done", inbox_folder: "unsorted" },
      properties: {
        type: "kind",
        area: "zone",
        date: "day",
        source: "origin",
        source_id: "origin_id",
      },
      areas: ["home", "office"],
      sources: ["fireflies", "gmail"],
      types: {
        meeting: { value: "call", folder: "{area}/calls", immutable_body: true },
        note: { value: "scribble" },
      },
    });
  });

  it("replaces the default types and areas when the file sets them", async () => {
    writeConfig("areas: [home]\ntypes:\n  note: { value: scribble }\n");
    const config = await loadVaultConfig(dir);
    expect(config.areas).toStrictEqual(["home"]);
    expect(Object.keys(config.types)).toStrictEqual(["note"]);
  });
});

describe("loadVaultConfig strictness", () => {
  it.each([
    ["a top-level key", "other: 1\n", "other"],
    ["a vault key", "vault:\n  archive: old\n", "vault.archive"],
    ["a properties key", "properties:\n  colour: red\n", "properties.colour"],
    [
      "a key inside a type",
      "types:\n  idea:\n    value: idea\n    colour: red\n",
      "types.idea.colour",
    ],
  ])("rejects %s", async (_name, yaml, keyPath) => {
    await expectInvalid(yaml, keyPath);
  });

  it.each([
    ["a number for a folder", "vault:\n  archive_folder: 42\n", "vault.archive_folder"],
    ["a string for areas", "areas: work\n", "areas"],
    [
      "a string for immutable_body",
      'types:\n  meeting:\n    value: meeting\n    immutable_body: "yes"\n',
      "types.meeting.immutable_body",
    ],
    ["another version", "version: 2\n", "version"],
    ["an empty property name", 'properties:\n  type: ""\n', "properties.type"],
    ["a non-string source", "sources: [1]\n", "sources.0"],
    ["no types", "types: {}\n", "types"],
    ["no areas", "areas: []\n", "areas"],
    ["a top-level list", "- a\n- b\n", ""],
  ])("rejects %s", async (_name, yaml, keyPath) => {
    await expectInvalid(yaml, keyPath);
  });

  it.each([
    ["an area with a slash", "areas: [a/b]\n", "areas.0"],
    ["an area starting with a dot", "areas: ['.hidden']\n", "areas.0"],
    ["a duplicate area", "areas: [work, work]\n", "areas"],
    [
      "an archive folder outside the vault",
      "vault:\n  archive_folder: ../x\n",
      "vault.archive_folder",
    ],
    ["an absolute inbox folder", "vault:\n  inbox_folder: /x\n", "vault.inbox_folder"],
    ["a drive letter in a folder", 'vault:\n  inbox_folder: "C:x"\n', "vault.inbox_folder"],
    ["a backslash in a folder", 'vault:\n  inbox_folder: "a\\\\b"\n', "vault.inbox_folder"],
    [
      "an unknown placeholder",
      'types:\n  idea: { value: idea, folder: "{year}/x" }\n',
      "types.idea.folder",
    ],
    [
      "a type folder outside the vault",
      "types:\n  idea: { value: idea, folder: ../x }\n",
      "types.idea.folder",
    ],
    ["duplicate property names", "properties:\n  type: kind\n  area: kind\n", "properties"],
    ["duplicate type values", "types:\n  a: { value: same }\n  b: { value: same }\n", "types"],
    ["a type key that is not a word", "types:\n  Bad Key: { value: x }\n", "types.Bad Key"],
  ])("rejects %s", async (_name, yaml, keyPath) => {
    await expectInvalid(yaml, keyPath);
  });
});

describe("loadVaultConfig unreadable files", () => {
  it("throws ConfigInvalidError with an empty key path on invalid YAML", async () => {
    await expectInvalid("vault: [unclosed\n", "");
  });

  it("throws ConfigInvalidError with an empty key path on a multi-document file", async () => {
    await expectInvalid("vault:\n  archive_folder: A\n---\nvault:\n  archive_folder: B\n", "");
  });

  it("refuses a --- js fence without running its code", async () => {
    await expectInvalid("--- js\nglobalThis.__pwned = true\n---\n", "");
    expect((globalThis as { __pwned?: unknown }).__pwned).toBeUndefined();
  });

  it("rethrows a read error other than ENOENT unchanged", async () => {
    mkdirSync(join(dir, ".2brain", "config.yaml"), { recursive: true });
    const error = await loadVaultConfig(dir).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ConfigInvalidError);
    expect((error as NodeJS.ErrnoException).code).toBe("EISDIR");
  });
});

describe("expandTypeFolders", () => {
  it("expands {area} per area and keeps first-seen order without duplicates", () => {
    expect(expandTypeFolders(DEFAULT_VAULT_CONFIG)).toStrictEqual([
      "personal/meetings",
      "work/meetings",
      "personal/projects",
      "work/projects",
      "personal/resources",
      "work/resources",
      "topics",
      "people",
      "recipes",
      "inbox",
      "daily",
      "reviews",
    ]);
  });

  it("skips types without a folder and keeps folders without {area} as they are", () => {
    const config = {
      ...DEFAULT_VAULT_CONFIG,
      areas: ["home"],
      types: {
        a: { value: "a" },
        b: { value: "b", folder: "plain" },
        c: { value: "c", folder: "{area}/x" },
      },
    };
    expect(expandTypeFolders(config)).toStrictEqual(["plain", "home/x"]);
  });
});
