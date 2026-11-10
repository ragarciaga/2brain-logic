import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { scanOwnerData } from "./plugin/helpers/plugin-scan.js";

const ROOT = resolve(import.meta.dirname, "..");
const read = (name: string): string => readFileSync(resolve(ROOT, name), "utf8");
const guide = read("docs/GUIDE-obsidian.md");

describe("docs/GUIDE-obsidian.md (#253)", () => {
  it("has its sections in order", () => {
    const found = guide
      .split("\n")
      .filter((l) => l.startsWith("## "))
      .map((l) => l.slice(3));
    expect(found).toEqual([
      "Before you start",
      "Clone the vault",
      "Open it in Obsidian",
      "Install Obsidian Git",
      "Templates",
      "Why both sides can write",
      "What to avoid",
      "Phone",
    ]);
  });

  it("is linked from the README and from INSTALL", () => {
    expect(read("README.md")).toContain("docs/GUIDE-obsidian.md");
    expect(read("docs/INSTALL.md")).toContain("GUIDE-obsidian.md");
  });

  it("points to the conflict rule and keeps placeholders for the owner's repository", () => {
    expect(guide).toContain("docs/adr/0008-vault-safety.md");
    expect(guide).toContain("<owner>/<vault-repository>");
  });

  it("has no owner data and no em dash", () => {
    // Product sites and the GitHub host of the clone example are facts, not owner data.
    const allowed = ["obsidian.md", "git-scm.com", "github.com"];
    const found = scanOwnerData(guide).filter((f) => !allowed.some((a) => f.match.includes(a)));
    expect(found).toEqual([]);
    expect(guide).not.toContain(String.fromCodePoint(0x2014));
  });
});
