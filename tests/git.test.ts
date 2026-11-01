import { randomBytes } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  classifyRemoteError,
  commitFile,
  ensureClone,
  GitError,
  headSha,
  runGit,
  unstageFile,
} from "../src/git/index.js";
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

  it("unstageFile unstages only the named new file when its name is a glob matching another", async () => {
    writeFileSync(join(fixture.vaultDir, "c.md"), "c\n");
    writeFileSync(join(fixture.vaultDir, "[cd].md"), "cd\n");
    git(fixture.vaultDir, ["add", "--", "c.md", "[cd].md"]);
    await unstageFile(fixture.vaultDir, "[cd].md");
    expect(git(fixture.vaultDir, ["diff", "--cached", "--name-only"])).toBe("c.md");
    expect(readFileSync(join(fixture.vaultDir, "[cd].md"), "utf8")).toBe("cd\n");
  });

  it("unstageFile on a tracked file that was deleted and re-created stages no deletion", async () => {
    rmSync(join(fixture.vaultDir, "a.md"));
    writeFileSync(join(fixture.vaultDir, "a.md"), "recreated\n");
    git(fixture.vaultDir, ["add", "--", "a.md"]);
    await unstageFile(fixture.vaultDir, "a.md");
    expect(git(fixture.vaultDir, ["diff", "--cached", "--name-status"])).toBe("");
    expect(git(fixture.vaultDir, ["ls-files", "--", "a.md"])).toBe("a.md");
    expect(readFileSync(join(fixture.vaultDir, "a.md"), "utf8")).toBe("recreated\n");
  });

  it("unstageFile resolves for a path that was never staged", async () => {
    await expect(unstageFile(fixture.vaultDir, "never.md")).resolves.toBeUndefined();
  });

  it("headSha returns the sha HEAD points to", async () => {
    expect(await headSha(fixture.vaultDir)).toBe(git(fixture.vaultDir, ["rev-parse", "HEAD"]));
  });

  it("runGit keeps literal pathspecs even when the caller asks for globbing", async () => {
    await runGit(fixture.vaultDir, ["add", "--", "[ab].md"], { GIT_LITERAL_PATHSPECS: "0" });
    expect(git(fixture.vaultDir, ["diff", "--cached", "--name-only"])).toBe("[ab].md");
  });
});

describe("remote error mapping", () => {
  const remote = "ssh://git@host.invalid/x.git";

  /** A fake ssh command: writes `text` to stderr and exits 255, or sleeps when `sleepMs` is set. */
  function fakeSsh(name: string, text: string, sleepMs = 0): Record<string, string> {
    const script = join(fixture.root, name);
    const body = sleepMs
      ? `setTimeout(() => {}, ${sleepMs});\n`
      : `process.stderr.write(${JSON.stringify(text)});\nprocess.exit(255);\n`;
    writeFileSync(script, body);
    return { GIT_SSH_COMMAND: `node "${script}"` };
  }

  async function failure(run: Promise<unknown>): Promise<unknown> {
    try {
      await run;
    } catch (error) {
      return error;
    }
    throw new Error("expected a rejection");
  }

  it("maps exit 128 permission denied to remote_auth_failed", async () => {
    const env = fakeSsh("denied.mjs", "Permission denied (publickey).");
    const err = await failure(runGit(fixture.root, ["ls-remote", remote], env));
    expect(err).toBeInstanceOf(GitError);
    expect((err as GitError).exitCode).toBe(128);
    expect((err as GitError).permissionDenied).toBe(true);
    expect(classifyRemoteError(err)).toBe("remote_auth_failed");
  });

  it("maps a refused connection at exit 128 to remote_unreachable", async () => {
    const env = fakeSsh("refused.mjs", "Connection refused");
    const err = await failure(runGit(fixture.root, ["ls-remote", remote], env));
    expect((err as GitError).exitCode).toBe(128);
    expect((err as GitError).permissionDenied).toBe(false);
    expect(classifyRemoteError(err)).toBe("remote_unreachable");
  });

  it("maps timeout to remote_unreachable", { timeout: 10_000 }, async () => {
    const env = fakeSsh("sleep.mjs", "", 3000);
    const err = await failure(runGit(fixture.root, ["ls-remote", remote], env, { timeoutMs: 200 }));
    expect((err as GitError).exitCode).toBeNull();
    expect(classifyRemoteError(err)).toBe("remote_unreachable");
  });

  it("GitError message holds only subcommand and exit code", async () => {
    const mark = `MARK-${randomBytes(6).toString("hex")}`;
    const env = fakeSsh("mark.mjs", `Permission denied (publickey). ${mark}`);
    const err = (await failure(runGit(fixture.root, ["ls-remote", remote], env))) as GitError;
    expect(err.permissionDenied).toBe(true);
    for (const text of [err.message, err.stack ?? "", String(err), JSON.stringify(err)]) {
      expect(text).not.toContain(mark);
    }
  });

  it("legacy constructor keeps its behavior", () => {
    const err = new GitError("push", 128);
    expect(err.permissionDenied).toBe(false);
    expect(err.message).toBe("git push failed (exit 128)");
  });

  it("classifyRemoteError returns null for a non-GitError", () => {
    expect(classifyRemoteError(new Error("x"))).toBeNull();
  });
});
