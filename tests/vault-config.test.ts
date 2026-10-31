import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadVaultConfig } from "../src/config/vault-config.js";

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

describe("loadVaultConfig", () => {
  it("defaults archive_folder to Archive when the config is absent", async () => {
    expect((await loadVaultConfig(dir)).vault.archive_folder).toBe("Archive");
  });

  it("defaults archive_folder when the file does not set it", async () => {
    writeConfig("other: 1\n");
    expect((await loadVaultConfig(dir)).vault.archive_folder).toBe("Archive");
  });

  it("defaults archive_folder when the vault section is empty", async () => {
    writeConfig("vault: {}\n");
    expect((await loadVaultConfig(dir)).vault.archive_folder).toBe("Archive");
  });

  it("returns the file's archive_folder", async () => {
    writeConfig("vault:\n  archive_folder: Old Stuff\n");
    expect((await loadVaultConfig(dir)).vault.archive_folder).toBe("Old Stuff");
  });

  it("returns the file's value when the file starts with a --- marker", async () => {
    writeConfig("---\nvault:\n  archive_folder: Old Stuff\n");
    expect((await loadVaultConfig(dir)).vault.archive_folder).toBe("Old Stuff");
  });

  it("throws an error naming the file on invalid YAML", async () => {
    writeConfig("vault: [unclosed\n");
    await expect(loadVaultConfig(dir)).rejects.toThrow(/\.2brain\/config\.yaml/);
  });

  it("throws an error naming the file on a non-string value", async () => {
    writeConfig("vault:\n  archive_folder: 42\n");
    await expect(loadVaultConfig(dir)).rejects.toThrow(/\.2brain\/config\.yaml/);
  });

  it("throws an error naming the file on a multi-document file", async () => {
    writeConfig("vault:\n  archive_folder: A\n---\nvault:\n  archive_folder: B\n");
    await expect(loadVaultConfig(dir)).rejects.toThrow(/\.2brain\/config\.yaml/);
  });
});
