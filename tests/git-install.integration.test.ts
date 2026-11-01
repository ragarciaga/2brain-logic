import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CLONE_TIMEOUT_MS,
  classifyRemoteError,
  cloneInto,
  currentBranch,
  GitError,
  hasCommits,
  lsRemote,
  originUrl,
  pushBranch,
  pushDryRun,
} from "../src/git/index.js";
import { createGitFixture, type GitFixture, git } from "./helpers/git-fixture.js";

let fixture: GitFixture;
let clone: string;

beforeEach(async () => {
  fixture = createGitFixture();
  clone = join(fixture.root, "installer-clone");
  await cloneInto(fixture.remote, clone);
});

afterEach(() => {
  fixture.cleanup();
});

function commitLocal(): void {
  writeFileSync(join(clone, "extra.md"), "extra\n");
  git(clone, ["add", "extra.md"]);
  git(clone, ["commit", "-m", "extra"]);
}

describe("installer git functions", () => {
  it("CLONE_TIMEOUT_MS is 120 seconds", () => {
    expect(CLONE_TIMEOUT_MS).toBe(120_000);
  });

  it("cloneInto fails with GitError and a null exit code when the transport hangs", async () => {
    // A fake ssh that sleeps: the clone cannot finish before the timeout kills it.
    const dir = mkdtempSync(join(tmpdir(), "2brain-fakessh-"));
    const script = join(dir, "hang.sh");
    writeFileSync(script, "#!/bin/sh\nexec sleep 3\n");
    const err = await cloneInto(
      "ssh://git@example.com/vault.git",
      join(fixture.root, "slow"),
      { GIT_SSH_COMMAND: `sh ${script}` },
      200,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(GitError);
    expect(err.exitCode).toBeNull();
    expect(classifyRemoteError(err)).toBe("remote_unreachable");
  });

  it("hasCommits is false on an empty clone and true after a commit", async () => {
    const bare = join(fixture.root, "empty.git");
    git(fixture.root, ["init", "--bare", bare]);
    const dir = join(fixture.root, "empty-clone");
    await cloneInto(bare, dir);
    expect(await hasCommits(dir)).toBe(false);
    expect(await hasCommits(clone)).toBe(true);
  });

  it("currentBranch returns the branch name and rejects on a detached HEAD", async () => {
    expect(await currentBranch(clone)).toBe("main");
    git(clone, ["checkout", "--detach"]);
    await expect(currentBranch(clone)).rejects.toBeInstanceOf(GitError);
  });

  it("cloneInto clones the remote and originUrl returns it", async () => {
    expect(git(clone, ["rev-parse", "HEAD"])).toBe(git(fixture.remote, ["rev-parse", "main"]));
    expect(await originUrl(clone)).toBe(fixture.remote);
  });

  it("lsRemote lists the branch names", async () => {
    expect(await lsRemote(clone, fixture.remote)).toEqual(["main"]);
  });

  it("pushDryRun resolves and leaves the remote refs unchanged", async () => {
    commitLocal();
    const before = git(fixture.remote, ["show-ref"]);
    await pushDryRun(clone);
    expect(git(fixture.remote, ["show-ref"])).toBe(before);
  });

  it("pushBranch moves the named remote branch to HEAD", async () => {
    commitLocal();
    const seed = git(fixture.remote, ["rev-parse", "main"]);
    await pushBranch(clone, "main");
    expect(git(fixture.remote, ["rev-parse", "main"])).toBe(git(clone, ["rev-parse", "HEAD"]));
    git(clone, ["reset", "--hard", seed]);
    commitLocal();
    await pushBranch(clone, "other");
    expect(git(fixture.remote, ["rev-parse", "other"])).toBe(git(clone, ["rev-parse", "HEAD"]));
  });

  it.each(["a:b", "-x", "a..b", ""])("pushBranch rejects unsafe branch name %j", async (name) => {
    commitLocal();
    const before = git(fixture.remote, ["show-ref"]);
    const err = await pushBranch(clone, name).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(GitError);
    expect(err.message).toBe("invalid branch name");
    expect(git(fixture.remote, ["show-ref"])).toBe(before);
  });

  it("lsRemote on a missing repository maps to remote_unreachable", async () => {
    const err = await lsRemote(clone, join(fixture.root, "missing.git")).catch((e) => e);
    expect(classifyRemoteError(err)).toBe("remote_unreachable");
  });
});
