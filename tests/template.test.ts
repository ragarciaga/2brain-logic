import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_VAULT_CONFIG } from "../src/config/defaults.js";
import { expandTypeFolders, loadVaultConfig } from "../src/config/vault-config.js";
import { NoteInput } from "../src/vault/note-schema.js";

const TEMPLATE = join(import.meta.dirname, "..", "vault-template");

function listFiles(root: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(root)) {
    const full = join(root, name);
    if (statSync(full).isDirectory()) out.push(...listFiles(full));
    else out.push(relative(TEMPLATE, full).split(sep).join("/"));
  }
  return out.sort();
}

function templateFolders(): string[] {
  return [
    ...expandTypeFolders(DEFAULT_VAULT_CONFIG),
    DEFAULT_VAULT_CONFIG.vault.archive_folder,
    DEFAULT_VAULT_CONFIG.vault.inbox_folder,
  ];
}

describe("vault template config", () => {
  it("loads to exactly the default config", async () => {
    expect(await loadVaultConfig(TEMPLATE)).toStrictEqual(DEFAULT_VAULT_CONFIG);
  });
});

describe("vault template folders", () => {
  it("has a README.md in every configured folder", () => {
    for (const folder of new Set(templateFolders())) {
      expect(existsSync(join(TEMPLATE, folder, "README.md")), `${folder}/README.md`).toBe(true);
    }
  });

  it("holds only the config and one README.md per folder", () => {
    const expected = [
      ".2brain/config.yaml",
      ...[...new Set(templateFolders())].map((folder) => `${folder}/README.md`),
    ].sort();
    expect(listFiles(TEMPLATE)).toStrictEqual(expected);
  });

  it("uses README paths that pass the note path rules", () => {
    for (const file of listFiles(TEMPLATE).filter((f) => f.endsWith(".md"))) {
      expect(NoteInput.shape.path.safeParse(file).success, file).toBe(true);
    }
  });
});

// Owner-data detectors. Each has a positive control below so a broken pattern cannot pass.
const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/;
const URL_LIKE = /\b[a-z][a-z0-9+.-]*:\/\/\S+/i;
const DOMAIN = /\b(?:[a-z0-9-]+\.)+(?:com|org|net|io|dev|app|co|es|mx|ai|me)\b/gi;
const MID_SENTENCE_CAPITAL = /[a-z,;:] [A-Z][a-z]+/;

function ownerDataFindings(text: string): string[] {
  const found: string[] = [];
  if (EMAIL.test(text)) found.push("email");
  if (URL_LIKE.test(text)) found.push("url");
  for (const match of text.match(DOMAIN) ?? []) {
    if (match.toLowerCase() !== "example.com") found.push(`domain ${match}`);
  }
  if (MID_SENTENCE_CAPITAL.test(text)) found.push("capitalized word mid-sentence");
  return found;
}

describe("vault template owner data", () => {
  it("has no emails, URLs, other domains or proper nouns", () => {
    for (const file of listFiles(TEMPLATE)) {
      const text = readFileSync(join(TEMPLATE, file), "utf8");
      expect(ownerDataFindings(text), file).toStrictEqual([]);
    }
  });

  it("detects each kind of owner data", () => {
    expect(ownerDataFindings("write to ana@example.com")).toContain("email");
    expect(ownerDataFindings("see https://example.com/x")).toContain("url");
    expect(ownerDataFindings("host acme.com here")).toContain("domain acme.com");
    expect(ownerDataFindings("notes from Ana today")).toContain("capitalized word mid-sentence");
    expect(ownerDataFindings("host example.com here")).toStrictEqual([]);
    expect(ownerDataFindings("A plain sentence. Another one.")).toStrictEqual([]);
  });
});
