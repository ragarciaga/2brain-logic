import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commitFile, ensureClone, runGit } from "../src/git/index.js";
import { createGitFixture, type GitFixture, git, TEST_AUTHOR } from "./helpers/git-fixture.js";

let fixture: GitFixture;

// Git matches a pathspec against tracked files by glob as well as literally, so the
// discriminating setup is two tracked files that both have changes: `[ab].md` is a glob that
// also matches `a.md`. With untracked files git only takes the exact name.
beforeEach(async () => {
  fixture = createGitFixture();
  await ensureClone(fixture.vaultDir, fixture.remote);
  writeFileSync(join(fixture.vaultDir, "a.md"), "a\n");
  writeFileSync(join(fixture.vaultDir, "[ab].md"), "ab\n");
  git(fixture.vaultDir, ["add", "--", "a.md", "[ab].md"]);
  git(fixture.vaultDir, ["commit", "-m", "seed files"]);
  writeFileSync(join(fixture.vaultDir, "a.md"), "a changed\n");
  writeFileSync(join(fixture.vaultDir, "[ab].md"), "ab changed\n");
});

afterEach(() => {
  fixture.cleanup();
});

describe("literal pathspecs", () => {
  it("commitFile commits only the named file when its name is a glob that matches another", async () => {
    const sha = await commitFile(fixture.vaultDir, "[ab].md", "change ab", TEST_AUTHOR);
    expect(git(fixture.vaultDir, ["show", "--name-only", "--format=", "HEAD"])).toBe("[ab].md");
    expect(git(fixture.vaultDir, ["status", "--porcelain"])).toBe("M a.md");
    expect(sha).toBe(git(fixture.vaultDir, ["rev-parse", "HEAD"]));
  });

  it("runGit keeps literal pathspecs even when the caller asks for globbing", async () => {
    await runGit(fixture.vaultDir, ["add", "--", "[ab].md"], { GIT_LITERAL_PATHSPECS: "0" });
    expect(git(fixture.vaultDir, ["diff", "--cached", "--name-only"])).toBe("[ab].md");
  });
});
