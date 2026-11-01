import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO = join(import.meta.dirname, "..");
let dir: string;
let env: NodeJS.ProcessEnv;

function checkText(path: string): string {
  const out = execFileSync("git", ["check-attr", "text", "--", path], {
    cwd: dir,
    encoding: "utf8",
    env,
  }).trim();
  return out.slice(out.lastIndexOf(": ") + 2);
}

function expectedFixtures(base: string, prefix: string): string[] {
  return readdirSync(join(base, prefix), { withFileTypes: true }).flatMap((entry) => {
    const rel = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) return expectedFixtures(base, rel);
    return entry.name.endsWith(".expected.md") ? [rel] : [];
  });
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "2brain-attr-"));
  const emptyConfig = join(dir, "empty-gitconfig");
  writeFileSync(emptyConfig, "");
  env = { ...process.env, GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: "1" };
  execFileSync("git", ["init", "-q"], { cwd: dir, env });
  copyFileSync(join(REPO, ".gitattributes"), join(dir, ".gitattributes"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("D6: .gitattributes keeps expected fixtures byte exact", () => {
  it("every expected.md fixture is -text", () => {
    const fixtures = expectedFixtures(REPO, "tests/fixtures");
    expect(fixtures.length).toBeGreaterThanOrEqual(2);
    for (const path of fixtures) expect(checkText(path), path).toBe("unset");
  });

  it("a nested fixture is covered", () => {
    expect(checkText("tests/fixtures/a/b/x.expected.md")).toBe("unset");
  });

  it("the pattern is narrow", () => {
    expect(checkText("tests/fixtures/meetings/fireflies-basic.json")).toBe("unspecified");
    expect(checkText("x.expected.md")).toBe("unspecified");
    expect(checkText("src/x.md")).toBe("unspecified");
  });
});
