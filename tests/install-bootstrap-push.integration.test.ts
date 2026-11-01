import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cloneInto, GitError, PUSH_TIMEOUT_MS } from "../src/git/index.js";
import {
  type BootstrapDeps,
  bootstrapVault,
  defaultBootstrapDeps,
  FIX_AUTH,
  FIX_UNREACHABLE,
  SEED_MESSAGE,
} from "../src/install/vault-bootstrap.js";
import { createGitFixture, type GitFixture, git } from "./helpers/git-fixture.js";

const AUTHOR = { name: "Seed Author", email: "seed-author@example.com" };
const MARKER = "SECRETMARKER4242";

let fixture: GitFixture;

beforeEach(() => {
  fixture = createGitFixture();
});

afterEach(() => {
  fixture.cleanup();
});

/** Make every push to `bare` fail; the hook echoes a marker that must never reach a result. */
function refuse(bare: string): void {
  const hook = join(bare, "hooks", "pre-receive");
  mkdirSync(join(bare, "hooks"), { recursive: true });
  writeFileSync(hook, `#!/bin/sh\necho ${MARKER} >&2\nexit 1\n`);
  // Running as root ignores file modes, but exec still needs the x bit.
  chmodSync(hook, 0o755);
}

function allow(bare: string): void {
  rmSync(join(bare, "hooks", "pre-receive"), { force: true });
}

function counting(): { deps: BootstrapDeps; calls: { push: number } } {
  const calls = { push: 0 };
  return {
    calls,
    deps: {
      ...defaultBootstrapDeps,
      pushBranch: (...a) => {
        calls.push += 1;
        return defaultBootstrapDeps.pushBranch(...a);
      },
    },
  };
}

function pushFromElsewhere(name: string): void {
  const other = fixture.cloneElsewhere(name);
  writeFileSync(join(other, "other.md"), "other\n");
  git(other, ["add", "other.md"]);
  git(other, ["commit", "-m", "other"]);
  git(other, ["push", "origin", "HEAD:refs/heads/main"]);
}

describe.skipIf(process.platform === "win32")("bootstrapVault push on re-run", () => {
  const opts = () => ({ remote: fixture.remote, vaultDir: fixture.vaultDir, author: AUTHOR });

  it("empty remote refused, the re-run pushes the same commit", async () => {
    const empty = join(fixture.root, "empty.git");
    git(fixture.root, ["init", "--bare", "--initial-branch=main", empty]);
    refuse(empty);
    const o = { remote: empty, vaultDir: fixture.vaultDir, author: AUTHOR };
    const first = await bootstrapVault(o);
    expect(first).toEqual({ code: "push_refused", fix: FIX_AUTH, seeded: false });
    expect(JSON.stringify(first)).not.toContain(MARKER);
    expect(git(fixture.vaultDir, ["log", "-1", "--format=%s"])).toBe(SEED_MESSAGE);
    expect(git(empty, ["for-each-ref"])).toBe("");
    const head = git(fixture.vaultDir, ["rev-parse", "HEAD"]);
    const count = git(fixture.vaultDir, ["rev-list", "--count", "HEAD"]);

    allow(empty);
    const second = await bootstrapVault(o);
    expect(second).toEqual({ code: "done", fix: "", seeded: false });
    expect(git(empty, ["rev-parse", "main"])).toBe(head);
    expect(git(fixture.vaultDir, ["rev-parse", "HEAD"])).toBe(head);
    expect(git(fixture.vaultDir, ["rev-list", "--count", "HEAD"])).toBe(count);
    expect(git(fixture.vaultDir, ["status", "--porcelain"])).toBe("");
  });

  it("existing-vault path refused, the re-run pushes the same commit", async () => {
    const seed = git(fixture.remote, ["rev-parse", "main"]);
    refuse(fixture.remote);
    const first = await bootstrapVault(opts());
    expect(first).toEqual({ code: "push_refused", fix: FIX_AUTH, seeded: false });
    expect(JSON.stringify(first)).not.toContain(MARKER);
    expect(git(fixture.remote, ["rev-parse", "main"])).toBe(seed);
    const head = git(fixture.vaultDir, ["rev-parse", "HEAD"]);
    expect(head).not.toBe(seed);

    allow(fixture.remote);
    const second = await bootstrapVault(opts());
    expect(second).toEqual({ code: "done", fix: "", seeded: false });
    expect(git(fixture.remote, ["rev-parse", "main"])).toBe(head);
    expect(git(fixture.vaultDir, ["rev-parse", "HEAD"])).toBe(head);
    expect(git(fixture.vaultDir, ["rev-list", "--count", "HEAD"])).toBe("2");
  });

  it("a refused re-run push stays push_refused and keeps the commit", async () => {
    refuse(fixture.remote);
    await bootstrapVault(opts());
    const head = git(fixture.vaultDir, ["rev-parse", "HEAD"]);
    const again = await bootstrapVault(opts());
    expect(again).toEqual({ code: "push_refused", fix: FIX_AUTH, seeded: false });
    expect(JSON.stringify(again)).not.toContain(MARKER);
    expect(git(fixture.vaultDir, ["rev-parse", "HEAD"])).toBe(head);
  });

  it("a valid-config clone level with origin pushes nothing", async () => {
    const other = fixture.cloneElsewhere("writer");
    mkdirSync(join(other, ".2brain"));
    writeFileSync(join(other, ".2brain/config.yaml"), "version: 1\n");
    git(other, ["add", "."]);
    git(other, ["commit", "-m", "config"]);
    git(other, ["push", "origin", "HEAD:refs/heads/main"]);
    await cloneInto(fixture.remote, fixture.vaultDir);
    const head = git(fixture.vaultDir, ["rev-parse", "HEAD"]);
    const { deps, calls } = counting();
    const result = await bootstrapVault(opts(), deps);
    expect(result).toEqual({ code: "done", fix: "", seeded: false });
    expect(calls.push).toBe(0);
    expect(git(fixture.vaultDir, ["rev-parse", "HEAD"])).toBe(head);
  });

  it("a clone behind origin keeps the seed commit and is refused as non-fast-forward", async () => {
    await cloneInto(fixture.remote, fixture.vaultDir);
    const old = git(fixture.vaultDir, ["rev-parse", "HEAD"]);
    pushFromElsewhere("writer");
    const theirs = git(fixture.remote, ["rev-parse", "main"]);
    const result = await bootstrapVault(opts());
    expect(result).toEqual({ code: "push_refused", fix: FIX_AUTH, seeded: false });
    expect(git(fixture.vaultDir, ["rev-parse", "HEAD^"])).toBe(old);
    expect(git(fixture.remote, ["rev-parse", "main"])).toBe(theirs);
  });

  it("a push timeout is remote_unreachable and keeps the seed commit", async () => {
    const result = await bootstrapVault(opts(), {
      ...defaultBootstrapDeps,
      pushBranch: () => Promise.reject(new GitError("push", null)),
    });
    expect(result).toEqual({ code: "remote_unreachable", fix: FIX_UNREACHABLE, seeded: false });
    expect(git(fixture.vaultDir, ["log", "-1", "--format=%s"])).toBe(SEED_MESSAGE);
  });

  it("a hanging transport on the re-run maps to remote_unreachable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "2brain-fakessh-"));
    try {
      refuse(fixture.remote);
      await bootstrapVault(opts());
      const script = join(dir, "hang.sh");
      writeFileSync(script, "#!/bin/sh\nexec sleep 3\n");
      git(fixture.vaultDir, ["remote", "set-url", "origin", "ssh://git@example.com/v.git"]);
      const result = await bootstrapVault(
        {
          ...opts(),
          remote: "ssh://git@example.com/v.git",
          gitEnv: { GIT_SSH_COMMAND: `sh ${script}` },
        },
        {
          ...defaultBootstrapDeps,
          lsRemote: async () => ["main"],
          pushBranch: (d, b, e) => defaultBootstrapDeps.pushBranch(d, b, e, 200),
        },
      );
      expect(result).toEqual({ code: "remote_unreachable", fix: FIX_UNREACHABLE, seeded: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes PUSH_TIMEOUT_MS explicitly", async () => {
    const seen: unknown[] = [];
    await bootstrapVault(opts(), {
      ...defaultBootstrapDeps,
      pushBranch: async (d, b, e, t) => {
        seen.push(t);
        return defaultBootstrapDeps.pushBranch(d, b, e, t);
      },
    });
    expect(seen).toEqual([PUSH_TIMEOUT_MS]);
  });
});
